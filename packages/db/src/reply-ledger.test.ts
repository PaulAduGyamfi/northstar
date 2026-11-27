import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { replyDraftClaim } from "./reply-ledger-schema.js";
import {
  claimDraft,
  DRAFT_CLAIM_LEASE_MS,
  DraftClaimsExhausted,
  DraftRecordConflict,
  dbMailLedger,
  MAX_DRAFT_CLAIMS,
  recordDraft,
} from "./reply-ledger-write.js";
import { domainEvent } from "./schema.js";
import { createTestDb, seedApplication, setGateClock, sqlState } from "./test/pglite.js";

// The Gmail draft writer's ledger (NS-237 slice 6, ADR-0025 item 5). Synthetic ids only.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";
const DECISION = "6f0c1b5e-2d4a-4c8e-9b7a-1e2f3a4b5c6d";
const OTHER_DECISION = "7a1d2c6f-3e5b-4d9f-8c8b-2f3a4b5c6d7e";
const T0 = new Date("2026-11-27T06:00:00.000Z");
// Moves the database clock the ledger reads (northstar_gate_now) to T0 + ms.
const clock = (ms: number) => setGateClock(db, new Date(T0.getTime() + ms));
const claimAt = async (ms: number, decisionId: string) => {
  await clock(ms);
  return claimDraft(db, candidateId, decisionId);
};
const recordAt = async (ms: number, decisionId: string, draftMessageId: string) => {
  await clock(ms);
  return recordDraft(db, candidateId, decisionId, draftMessageId);
};

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  candidateId = CandidateId.parse((await seedApplication(db, "discovered")).candidateId);
});

afterEach(async () => {
  await close();
});

const events = () =>
  db
    .select({ payload: domainEvent.payload, reason: domainEvent.reason })
    .from(domainEvent)
    .where(eq(domainEvent.type, "reply.draft_created"));

describe("claimDraft", () => {
  it("answers new for the first run on a decision", async () => {
    expect(await claimAt(0, DECISION)).toEqual({ state: "new" });
  });

  it("answers in_progress with the lease's end while the first run's claim is live", async () => {
    await claimAt(0, DECISION);
    expect(await claimAt(DRAFT_CLAIM_LEASE_MS - 1, DECISION)).toEqual({
      state: "in_progress",
      retryAt: new Date(T0.getTime() + DRAFT_CLAIM_LEASE_MS),
    });
  });

  it("answers unknown after the lease and takes a fresh claim, so the next run waits again", async () => {
    await claimAt(0, DECISION);
    const later = DRAFT_CLAIM_LEASE_MS + 1;
    expect([await claimAt(later, DECISION), await claimAt(later + 1, DECISION)]).toEqual([
      { state: "unknown" },
      { state: "in_progress", retryAt: new Date(T0.getTime() + later + DRAFT_CLAIM_LEASE_MS) },
    ]);
  });

  it("answers done with the recorded draft's id once one is recorded", async () => {
    await claimAt(0, DECISION);
    await recordAt(1, DECISION, "18c0ffee");
    expect(await claimAt(2, DECISION)).toEqual({
      state: "done",
      draftMessageId: "18c0ffee",
    });
  });

  // PGlite runs one transaction at a time, so this checks the outcome of two runs, not the advisory
  // lock itself; on Postgres the lock serialises them the same way.
  it("gives two racing first runs one claim between them", async () => {
    const results = await Promise.all([claimAt(0, DECISION), claimAt(0, DECISION)]);
    expect(results.map((r) => r.state).sort()).toEqual(["in_progress", "new"]);
  });

  it("keeps each decision's claims apart", async () => {
    await claimAt(0, DECISION);
    expect(await claimAt(1, OTHER_DECISION)).toEqual({ state: "new" });
  });

  it("refuses a claim past the attempt bound by name, not as a database error", async () => {
    await db.insert(replyDraftClaim).values({
      candidateId,
      decisionId: DECISION,
      attempt: MAX_DRAFT_CLAIMS,
      claimedAt: T0,
    });
    await clock(DRAFT_CLAIM_LEASE_MS + 1);
    await expect(claimDraft(db, candidateId, DECISION)).rejects.toBeInstanceOf(
      DraftClaimsExhausted,
    );
  });
});

describe("recordDraft", () => {
  it("records the draft with a reply.draft_created event carrying ids and fixed words only", async () => {
    await claimAt(0, DECISION);
    await recordAt(1, DECISION, "18c0ffee");
    expect(await events()).toEqual([
      {
        payload: { decisionId: DECISION, draftMessageId: "18c0ffee" },
        reason: "Wrote your approved reply as a Gmail draft for you to send",
      },
    ]);
  });

  it("stores nothing more when the same draft is recorded twice", async () => {
    await recordAt(1, DECISION, "18c0ffee");
    await recordAt(2, DECISION, "18c0ffee");
    expect((await events()).length).toBe(1);
  });

  it("refuses a second, different draft for the same decision", async () => {
    await recordAt(1, DECISION, "18c0ffee");
    await expect(recordAt(2, DECISION, "18c0ffef")).rejects.toBeInstanceOf(DraftRecordConflict);
  });

  it("refuses a draft id that isn't Gmail's hex", async () => {
    await expect(recordAt(1, DECISION, "r-123")).rejects.toThrow("invalid draft message id");
  });
});

describe("dbMailLedger", () => {
  it("binds claim and record to the writer's ports", async () => {
    const ledger = dbMailLedger(db);
    const first = await ledger.claimDraft(candidateId, DECISION);
    await ledger.recordDraft(candidateId, DECISION, "abc123");
    expect([first, await ledger.claimDraft(candidateId, DECISION)]).toEqual([
      { state: "new" },
      { state: "done", draftMessageId: "abc123" },
    ]);
  });
});

describe("the ledger's tables", () => {
  it("refuse updates and deletes of claims and records", async () => {
    await claimAt(0, DECISION);
    await recordAt(1, DECISION, "18c0ffee");
    expect([
      await sqlState(db.execute(sql`UPDATE reply_draft_claim SET attempt = 2`)),
      await sqlState(db.execute(sql`DELETE FROM reply_draft_claim`)),
      await sqlState(db.execute(sql`UPDATE reply_draft_record SET draft_message_id = 'ab'`)),
      await sqlState(db.execute(sql`DELETE FROM reply_draft_record`)),
    ]).toEqual([RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION]);
  });

  it("refuse an attempt out of range", async () => {
    expect(
      await sqlState(
        db.insert(replyDraftClaim).values({ candidateId, decisionId: DECISION, attempt: 0 }),
      ),
    ).toBe(CHECK_VIOLATION);
  });
});
