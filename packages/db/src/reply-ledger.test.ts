import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { replyDraftClaim } from "./reply-ledger-schema.js";
import {
  claimDraft,
  DRAFT_CLAIM_LEASE_MS,
  DraftRecordConflict,
  dbMailLedger,
  recordDraft,
} from "./reply-ledger-write.js";
import { domainEvent } from "./schema.js";
import { createTestDb, seedApplication, sqlState } from "./test/pglite.js";

// The Gmail draft writer's ledger (NS-237 slice 6, ADR-0025 item 5). Synthetic ids only.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";
const DECISION = "6f0c1b5e-2d4a-4c8e-9b7a-1e2f3a4b5c6d";
const OTHER_DECISION = "7a1d2c6f-3e5b-4d9f-8c8b-2f3a4b5c6d7e";
const T0 = new Date("2026-11-27T06:00:00.000Z");
const at = (ms: number) => () => new Date(T0.getTime() + ms);

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
    expect(await claimDraft(db, candidateId, DECISION, at(0))).toEqual({ state: "new" });
  });

  it("answers in_progress with the lease's end while the first run's claim is live", async () => {
    await claimDraft(db, candidateId, DECISION, at(0));
    expect(await claimDraft(db, candidateId, DECISION, at(DRAFT_CLAIM_LEASE_MS - 1))).toEqual({
      state: "in_progress",
      retryAt: new Date(T0.getTime() + DRAFT_CLAIM_LEASE_MS),
    });
  });

  it("answers unknown after the lease and takes a fresh claim, so the next run waits again", async () => {
    await claimDraft(db, candidateId, DECISION, at(0));
    const later = DRAFT_CLAIM_LEASE_MS + 1;
    expect([
      await claimDraft(db, candidateId, DECISION, at(later)),
      await claimDraft(db, candidateId, DECISION, at(later + 1)),
    ]).toEqual([
      { state: "unknown" },
      { state: "in_progress", retryAt: new Date(T0.getTime() + later + DRAFT_CLAIM_LEASE_MS) },
    ]);
  });

  it("answers done with the recorded draft's id once one is recorded", async () => {
    await claimDraft(db, candidateId, DECISION, at(0));
    await recordDraft(db, candidateId, DECISION, "18c0ffee", at(1));
    expect(await claimDraft(db, candidateId, DECISION, at(2))).toEqual({
      state: "done",
      draftMessageId: "18c0ffee",
    });
  });

  // PGlite runs one transaction at a time, so this checks the outcome of two runs, not the advisory
  // lock itself; on Postgres the lock serialises them the same way.
  it("gives two racing first runs one claim between them", async () => {
    const results = await Promise.all([
      claimDraft(db, candidateId, DECISION, at(0)),
      claimDraft(db, candidateId, DECISION, at(0)),
    ]);
    expect(results.map((r) => r.state).sort()).toEqual(["in_progress", "new"]);
  });

  it("keeps each decision's claims apart", async () => {
    await claimDraft(db, candidateId, DECISION, at(0));
    expect(await claimDraft(db, candidateId, OTHER_DECISION, at(1))).toEqual({ state: "new" });
  });
});

describe("recordDraft", () => {
  it("records the draft with a reply.draft_created event carrying ids and fixed words only", async () => {
    await claimDraft(db, candidateId, DECISION, at(0));
    await recordDraft(db, candidateId, DECISION, "18c0ffee", at(1));
    expect(await events()).toEqual([
      {
        payload: { decisionId: DECISION, draftMessageId: "18c0ffee" },
        reason: "Wrote your approved reply as a Gmail draft for you to send",
      },
    ]);
  });

  it("stores nothing more when the same draft is recorded twice", async () => {
    await recordDraft(db, candidateId, DECISION, "18c0ffee", at(1));
    await recordDraft(db, candidateId, DECISION, "18c0ffee", at(2));
    expect((await events()).length).toBe(1);
  });

  it("refuses a second, different draft for the same decision", async () => {
    await recordDraft(db, candidateId, DECISION, "18c0ffee", at(1));
    await expect(recordDraft(db, candidateId, DECISION, "18c0ffef", at(2))).rejects.toBeInstanceOf(
      DraftRecordConflict,
    );
  });

  it("refuses a draft id that isn't Gmail's hex", async () => {
    await expect(recordDraft(db, candidateId, DECISION, "r-123", at(1))).rejects.toThrow(
      "invalid draft message id",
    );
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
    await claimDraft(db, candidateId, DECISION, at(0));
    await recordDraft(db, candidateId, DECISION, "18c0ffee", at(1));
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
