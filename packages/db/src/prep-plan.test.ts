import { CandidateId, prepPlanContentSha256, prepPlanSubject } from "@northstar/domain";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approvalRequest } from "./approval-schema.js";
import { requestApproval, withdrawApproval } from "./approval-write.js";
import type { Db } from "./db.js";
import { proposeInterviewPrep } from "./interview-prep-write.js";
import { interviewPrepProposal } from "./interview-schema.js";
import { decideInterview, recordInterviewDetection } from "./interview-write.js";
import {
  claimPrepWrite,
  dbCalendarLedger,
  MAX_PREP_CLAIMS,
  NorthstarCalendarConflict,
  PREP_CLAIM_LEASE_MS,
  PrepClaimsExhausted,
  PrepRecordConflict,
  prepWrittenReason,
  readNorthstarCalendar,
  recordPrepWrite,
  saveNorthstarCalendar,
} from "./prep-ledger-write.js";
import {
  northstarCalendar,
  prepPlanRequest,
  prepWriteClaim,
  prepWriteRecord,
} from "./prep-plan-schema.js";
import { readPrepPlan, requestPrepPlanApproval } from "./prep-plan-write.js";
import { domainEvent } from "./schema.js";
import { createTestDb, seedApplication, setGateClock, sqlState } from "./test/pglite.js";

// Prep plans through the Gate and the Calendar writer's ledger (NS-241 slice 4, ADR-0031) on
// PGlite. Invented ids only; calendar ids are built from Google's group-calendar domain.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";
const DECISION = "6f0c1b5e-2d4a-4c8e-9b7a-1e2f3a4b5c6d";
const OTHER_DECISION = "7a1d2c6f-3e5b-4d9f-8c8b-2f3a4b5c6d7e";
const CALENDAR = `c_0a1b2c3d@${"group.calendar.google.com"}`;
const T0 = new Date("2026-11-27T06:00:00.000Z");
const START = new Date("2026-12-01T15:00:00Z");
const END = new Date("2026-12-01T16:00:00Z");
const EVENT_ID = "a1b2c3d4e5f6g7h8";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let applicationId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "submitted");
  candidateId = CandidateId.parse(seeded.candidateId);
  applicationId = seeded.applicationId;
});
afterEach(() => close());

async function detect(start = START, end = END): Promise<string> {
  const stored = await recordInterviewDetection(db, {
    candidateId,
    detection: {
      applicationId,
      calendarEventId: EVENT_ID,
      format: "technical",
      start,
      end,
      interviewerCount: 2,
    },
  });
  if (!stored.ok) throw new Error(stored.error.kind);
  return stored.value.detectionId;
}

async function confirm(detectionId: string): Promise<void> {
  const decided = await decideInterview(db, { candidateId, detectionId, decision: "confirmed" });
  if (!decided.ok) throw new Error(decided.error.kind);
}

async function propose(detectionId: string, busyAll = false): Promise<string> {
  const proposed = await proposeInterviewPrep(db, {
    candidateId,
    detectionId,
    request: {
      // Busy the whole stretch from now to the interview: the planner places nothing.
      busy: busyAll ? [{ start: new Date("2026-11-27T00:00:00Z"), end: END }] : [],
      workingHours: { start: 540, end: 1020 },
      timeZone: "UTC",
      now: new Date("2026-11-27T12:00:00Z"),
    },
  });
  if (!proposed.ok) throw new Error(proposed.error.kind);
  return proposed.value.proposal.proposalId;
}

async function proposal(): Promise<{ detectionId: string; proposalId: string }> {
  const detectionId = await detect();
  await confirm(detectionId);
  return { detectionId, proposalId: await propose(detectionId) };
}

const file = (proposalId: string) => requestPrepPlanApproval(db, { candidateId, proposalId });

describe("requestPrepPlanApproval", () => {
  it("files one prep_plan request whose hash covers the stored blocks and detection", async () => {
    const { detectionId, proposalId } = await proposal();
    const filed = await file(proposalId);
    if (!filed.ok) throw new Error(filed.error.kind);
    const [request] = await db.select().from(approvalRequest);
    const plan = await readPrepPlan(db, candidateId, filed.value.requestId);
    expect([request?.kind, request?.subject, request?.contentSha256, plan?.contentSha256]).toEqual([
      "prep_plan",
      prepPlanSubject(proposalId),
      prepPlanContentSha256({
        proposalId,
        detectionId,
        detectionVersion: 1,
        blocks: plan?.blocks ?? [],
      }),
      request?.contentSha256,
    ]);
  });

  it("stores nothing new when filed twice, answering the first request", async () => {
    const { proposalId } = await proposal();
    const first = await file(proposalId);
    const second = await file(proposalId);
    expect([
      first.ok && first.value.stored,
      second.ok && second.value.replayed,
      second.ok && second.value.stored,
      second.ok && first.ok && second.value.requestId === first.value.requestId,
      (await db.select().from(prepPlanRequest)).length,
      (await db.select().from(approvalRequest)).length,
    ]).toEqual([true, true, false, true, 1, 1]);
  });

  it("answers the first request when filed again after Paul withdrew it, filing nothing new", async () => {
    const { proposalId } = await proposal();
    const first = await file(proposalId);
    if (!first.ok) throw new Error(first.error.kind);
    const closed = await withdrawApproval(db, {
      candidateId,
      requestId: first.value.requestId,
      by: "user",
    });
    if (!closed.ok) throw new Error(closed.error.kind);
    const again = await file(proposalId);
    expect([
      again.ok && again.value.requestId === first.value.requestId,
      again.ok && again.value.stored,
      (await db.select().from(approvalRequest)).length,
    ]).toEqual([true, false, 1]);
  });

  it("refuses an unknown proposal", async () => {
    expect(await file("8b2e3d7a-4f6c-4e0a-9d9c-3a4b5c6d7e8f")).toEqual({
      ok: false,
      error: { kind: "UnknownProposal" },
    });
  });

  it("refuses a proposal whose interview a reschedule replaced", async () => {
    const { proposalId } = await proposal();
    await detect(new Date("2026-12-02T15:00:00Z"), new Date("2026-12-02T16:00:00Z"));
    expect(await file(proposalId)).toEqual({ ok: false, error: { kind: "Superseded" } });
  });

  it("refuses a proposal whose interview Paul hasn't confirmed", async () => {
    const detectionId = await detect();
    // Stored directly: the proposer itself only plans for confirmed interviews.
    const [row] = await db
      .insert(interviewPrepProposal)
      .values({ candidateId, detectionId, missingPrep: 0, warmUpMissing: true })
      .returning({ id: interviewPrepProposal.id });
    expect(await file(row?.id ?? "")).toEqual({ ok: false, error: { kind: "NotConfirmed" } });
  });

  it("refuses an empty plan, since there is nothing to approve", async () => {
    const detectionId = await detect();
    await confirm(detectionId);
    const proposalId = await propose(detectionId, true);
    expect(await file(proposalId)).toEqual({ ok: false, error: { kind: "EmptyPlan" } });
  });
});

describe("readPrepPlan", () => {
  it("gives the detection the plan was filed for and, after a reschedule, the new current one", async () => {
    const { detectionId, proposalId } = await proposal();
    const filed = await file(proposalId);
    if (!filed.ok) throw new Error(filed.error.kind);
    const moved = await detect(new Date("2026-12-02T15:00:00Z"), new Date("2026-12-02T16:00:00Z"));
    const plan = await readPrepPlan(db, candidateId, filed.value.requestId);
    expect([plan?.filedFor, plan?.current]).toEqual([
      { detectionId, version: 1 },
      { detectionId: moved, version: 2, confirmed: false },
    ]);
  });

  it("answers null for another candidate's request or a malformed id", async () => {
    const { proposalId } = await proposal();
    const filed = await file(proposalId);
    if (!filed.ok) throw new Error(filed.error.kind);
    const other = CandidateId.parse((await seedApplication(db, "submitted")).candidateId);
    expect([
      await readPrepPlan(db, other, filed.value.requestId),
      await readPrepPlan(db, candidateId, "nope"),
    ]).toEqual([null, null]);
  });
});

describe("prep_plan_request's foreign key", () => {
  it("refuses a row behind a request of another kind or with another hash", async () => {
    const { detectionId, proposalId } = await proposal();
    const sha = "a".repeat(64);
    const other = await requestApproval(db, {
      candidateId,
      kind: "outreach",
      subject: `outreach:${proposalId}`,
      contentSha256: sha,
      facts: null,
      actor: "system",
      idempotencyKey: "forged",
    });
    if (!other.ok) throw new Error(other.error.kind);
    // A prep_plan request filed around the entry point, pinning another hash.
    const bare = await requestApproval(db, {
      candidateId,
      kind: "prep_plan",
      subject: prepPlanSubject(proposalId),
      contentSha256: sha,
      facts: null,
      actor: "system",
      idempotencyKey: "bare",
    });
    if (!bare.ok) throw new Error(bare.error.kind);
    const row = (requestId: string, contentSha256: string) =>
      db.insert(prepPlanRequest).values({
        candidateId,
        requestId,
        proposalId,
        detectionId,
        detectionVersion: 1,
        contentSha256,
      });
    expect([
      await sqlState(row(other.value.requestId, sha)),
      await sqlState(row(bare.value.requestId, "b".repeat(64))),
    ]).toEqual([FOREIGN_KEY_VIOLATION, FOREIGN_KEY_VIOLATION]);
  });
});

// Moves the database clock the ledger reads (northstar_gate_now) to T0 + ms.
const clock = (ms: number) => setGateClock(db, new Date(T0.getTime() + ms));
const claimAt = async (ms: number, decisionId: string) => {
  await clock(ms);
  return claimPrepWrite(db, candidateId, decisionId);
};

describe("claimPrepWrite", () => {
  it("answers new for the first run on a decision", async () => {
    expect(await claimAt(0, DECISION)).toEqual({ state: "new" });
  });

  it("answers in_progress with the lease's end while the first run's claim is live", async () => {
    await claimAt(0, DECISION);
    expect(await claimAt(PREP_CLAIM_LEASE_MS - 1, DECISION)).toEqual({
      state: "in_progress",
      retryAt: new Date(T0.getTime() + PREP_CLAIM_LEASE_MS),
    });
  });

  it("holds another decision of the same candidate while a write is live, so one calendar is made", async () => {
    await claimAt(0, DECISION);
    expect(await claimAt(1, OTHER_DECISION)).toEqual({
      state: "in_progress",
      retryAt: new Date(T0.getTime() + PREP_CLAIM_LEASE_MS),
    });
  });

  it("lets another decision go once the first is recorded", async () => {
    const { proposalId } = await proposal();
    await claimAt(0, DECISION);
    await recordPrepWrite(db, candidateId, { decisionId: DECISION, proposalId, blockCount: 3 });
    expect(await claimAt(1, OTHER_DECISION)).toEqual({ state: "new" });
  });

  it("answers unknown after the lease and takes a fresh claim, so the next run waits again", async () => {
    await claimAt(0, DECISION);
    const later = PREP_CLAIM_LEASE_MS + 1;
    expect([await claimAt(later, DECISION), await claimAt(later + 1, DECISION)]).toEqual([
      { state: "unknown" },
      { state: "in_progress", retryAt: new Date(T0.getTime() + later + PREP_CLAIM_LEASE_MS) },
    ]);
  });

  it("answers done with the block count once the write is recorded", async () => {
    const { proposalId } = await proposal();
    await claimAt(0, DECISION);
    await recordPrepWrite(db, candidateId, { decisionId: DECISION, proposalId, blockCount: 3 });
    expect(await claimAt(1, DECISION)).toEqual({ state: "done", blockCount: 3 });
  });

  it("refuses by name once a decision's runs have lapsed the most times allowed", async () => {
    await db.insert(prepWriteClaim).values(
      Array.from({ length: MAX_PREP_CLAIMS }, (_, i) => ({
        candidateId,
        decisionId: DECISION,
        attempt: i + 1,
        claimedAt: T0,
      })),
    );
    await expect(claimAt(PREP_CLAIM_LEASE_MS + 1, DECISION)).rejects.toThrow(PrepClaimsExhausted);
  });
});

describe("recordPrepWrite", () => {
  it("writes one event on the application with ids and the count, in fixed words", async () => {
    const { proposalId } = await proposal();
    const input = { decisionId: DECISION, proposalId, blockCount: 3 };
    await recordPrepWrite(db, candidateId, input);
    await recordPrepWrite(db, candidateId, input);
    const events = await db
      .select({ payload: domainEvent.payload, reason: domainEvent.reason })
      .from(domainEvent)
      .where(eq(domainEvent.type, "calendar.prep_written"));
    expect(events).toEqual([
      {
        payload: { applicationId, decisionId: DECISION, proposalId, blocks: 3 },
        reason: "Added 3 prep blocks to your Northstar calendar",
      },
    ]);
  });

  it("refuses a different second record for the same decision", async () => {
    const { proposalId } = await proposal();
    await recordPrepWrite(db, candidateId, { decisionId: DECISION, proposalId, blockCount: 3 });
    await expect(
      recordPrepWrite(db, candidateId, { decisionId: DECISION, proposalId, blockCount: 2 }),
    ).rejects.toThrow(PrepRecordConflict);
  });

  it("words one block in the singular", () => {
    expect(prepWrittenReason(1)).toBe("Added 1 prep block to your Northstar calendar");
  });
});

describe("the Northstar calendar's id", () => {
  it("is stored once with a fixed-word event that never holds the id", async () => {
    await saveNorthstarCalendar(db, candidateId, CALENDAR);
    await saveNorthstarCalendar(db, candidateId, CALENDAR);
    const events = await db
      .select({ payload: domainEvent.payload, reason: domainEvent.reason })
      .from(domainEvent)
      .where(eq(domainEvent.type, "calendar.created"));
    expect([await readNorthstarCalendar(db, candidateId), events]).toEqual([
      CALENDAR,
      [{ payload: {}, reason: "Set up your Northstar calendar for prep blocks" }],
    ]);
  });

  it("refuses a different second calendar and a malformed id", async () => {
    await saveNorthstarCalendar(db, candidateId, CALENDAR);
    await expect(
      saveNorthstarCalendar(db, candidateId, `c_ffff@${"group.calendar.google.com"}`),
    ).rejects.toThrow(NorthstarCalendarConflict);
    await expect(saveNorthstarCalendar(db, candidateId, "primary")).rejects.toThrow(
      "invalid calendar id",
    );
  });

  it("answers null before the writer made one", async () => {
    expect(await readNorthstarCalendar(db, candidateId)).toBeNull();
  });
});

describe("append-only", () => {
  it("refuses updates, deletes and truncates on every ledger table", async () => {
    const { proposalId } = await proposal();
    const filed = await file(proposalId);
    if (!filed.ok) throw new Error(filed.error.kind);
    const ledger = dbCalendarLedger(db);
    await ledger.claimPrepWrite(candidateId, DECISION);
    await ledger.recordPrepWrite(candidateId, { decisionId: DECISION, proposalId, blockCount: 3 });
    await ledger.saveNorthstarCalendar(candidateId, CALENDAR);
    expect([
      await sqlState(db.update(prepPlanRequest).set({ detectionVersion: 2 })),
      await sqlState(db.delete(prepPlanRequest)),
      await sqlState(db.update(prepWriteClaim).set({ attempt: 2 })),
      await sqlState(db.delete(prepWriteClaim)),
      await sqlState(db.update(prepWriteRecord).set({ blockCount: 1 })),
      await sqlState(db.delete(prepWriteRecord)),
      await sqlState(db.update(northstarCalendar).set({ calendarId: CALENDAR })),
      await sqlState(db.delete(northstarCalendar)),
      await sqlState(db.execute("truncate prep_write_claim")),
      await sqlState(db.execute("truncate prep_write_record")),
      await sqlState(db.execute("truncate northstar_calendar")),
    ]).toEqual(Array(11).fill(RESTRICT_VIOLATION));
  });

  it("refuses a block count or calendar id outside the CHECKs", async () => {
    expect([
      await sqlState(
        db.insert(prepWriteRecord).values({
          candidateId,
          decisionId: DECISION,
          proposalId: DECISION,
          blockCount: 0,
        }),
      ),
      await sqlState(db.insert(northstarCalendar).values({ candidateId, calendarId: "primary" })),
    ]).toEqual([CHECK_VIOLATION, CHECK_VIOLATION]);
  });
});
