import { CandidateId } from "@northstar/domain";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { prepReason, proposeInterviewPrep, readPrepProposal } from "./interview-prep-write.js";
import { interviewPrepBlock, interviewPrepProposal } from "./interview-schema.js";
import { decideInterview, recordInterviewDetection } from "./interview-write.js";
import { domainEvent } from "./schema.js";
import { createTestDb, seedApplication, sqlState } from "./test/pglite.js";

// Proposed interview prep (NS-241 slice 1) on PGlite. Invented event ids only.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";

const exporter = new InMemorySpanExporter();
beforeAll(() => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});
afterAll(() => trace.disable());

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let applicationId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "submitted");
  candidateId = CandidateId.parse(seeded.candidateId);
  applicationId = seeded.applicationId;
  exporter.reset();
});
afterEach(() => close());

// A Tuesday afternoon interview, planned from the Friday before, in UTC, 09:00–17:00.
const START = new Date("2026-12-01T15:00:00Z");
const END = new Date("2026-12-01T16:00:00Z");
const request = (over: Record<string, unknown> = {}) => ({
  busy: [],
  workingHours: { start: 540, end: 1020 },
  timeZone: "UTC",
  now: new Date("2026-11-27T12:00:00Z"),
  ...over,
});

async function detect(over: Record<string, unknown> = {}): Promise<string> {
  const stored = await recordInterviewDetection(db, {
    candidateId,
    detection: {
      applicationId,
      calendarEventId: "a1b2c3d4e5f6g7h8",
      format: "technical",
      start: START,
      end: END,
      interviewerCount: 2,
      ...over,
    },
  });
  if (!stored.ok) throw new Error("not detected");
  return stored.value.detectionId;
}

async function confirmed(): Promise<string> {
  const detectionId = await detect();
  const decided = await decideInterview(db, { candidateId, detectionId, decision: "confirmed" });
  if (!decided.ok) throw new Error("not decided");
  return detectionId;
}

const propose = (detectionId: string, over: Record<string, unknown> = {}) =>
  proposeInterviewPrep(db, { candidateId, detectionId, request: request(over) });

const events = () =>
  db.select().from(domainEvent).where(eq(domainEvent.type, "interview.prep_proposed"));
const at = (iso: string) => new Date(iso);

describe("proposeInterviewPrep", () => {
  it("stores the planner's blocks for a confirmed interview with one event", async () => {
    const detectionId = await confirmed();
    const result = await propose(detectionId);
    if (!result.ok) throw new Error(result.error.kind);
    expect([result.value.recorded, result.value.proposal.blocks]).toEqual([
      true,
      [
        { kind: "prep", start: at("2026-11-30T09:00:00Z"), end: at("2026-11-30T09:45:00Z") },
        { kind: "prep", start: at("2026-12-01T09:00:00Z"), end: at("2026-12-01T09:45:00Z") },
        { kind: "warm_up", start: at("2026-12-01T14:00:00Z"), end: at("2026-12-01T14:15:00Z") },
      ],
    ]);
  });

  it("writes one event on the application with ids and counts only", async () => {
    const detectionId = await confirmed();
    const result = await propose(detectionId, { timeZone: "America/New_York" });
    if (!result.ok) throw new Error(result.error.kind);
    const [event] = await events();
    expect([event?.aggregate, event?.actor, event?.payload]).toEqual([
      `application:${applicationId}`,
      "system",
      {
        applicationId,
        detectionId,
        proposalId: result.value.proposal.proposalId,
        prepBlocks: 2,
        missingPrep: 0,
        warmUp: true,
      },
    ]);
  });

  it("never puts the time zone in the event or its span", async () => {
    const detectionId = await confirmed();
    await propose(detectionId, { timeZone: "America/New_York" });
    const [event] = await events();
    const spans = JSON.stringify(exporter.getFinishedSpans().map((s) => s.attributes));
    expect([
      JSON.stringify([event?.reason, event?.payload]).includes("New_York"),
      spans.includes("New_York"),
    ]).toEqual([false, false]);
  });

  it("stores one proposal and one event when called twice, answering the first", async () => {
    const detectionId = await confirmed();
    const first = await propose(detectionId);
    // A different clock the second time: the first plan stands, not a new one.
    const again = await propose(detectionId, { now: new Date("2026-11-30T12:00:00Z") });
    if (!first.ok || !again.ok) throw new Error("not proposed");
    expect([
      again.value.recorded,
      again.value.proposal,
      (await db.select().from(interviewPrepProposal)).length,
      (await events()).length,
    ]).toEqual([false, first.value.proposal, 1, 1]);
  });

  it("records what the planner couldn't place", async () => {
    const detectionId = await confirmed();
    // Busy every working day before, and over the warm-up.
    const busy = ["2026-11-28", "2026-11-29", "2026-11-30", "2026-12-01"].map((d) => ({
      start: at(`${d}T09:00:00Z`),
      end: at(`${d}T17:00:00Z`),
    }));
    const result = await propose(detectionId, { busy });
    if (!result.ok) throw new Error(result.error.kind);
    const [event] = await events();
    expect([
      result.value.proposal.blocks,
      result.value.proposal.missingPrep,
      result.value.proposal.warmUpMissing,
      event?.reason,
    ]).toEqual([[], 2, true, "Proposed no prep blocks and no warm-up for your interview"]);
  });

  it("refuses an interview Paul hasn't decided, storing nothing", async () => {
    const detectionId = await detect();
    expect([await propose(detectionId), (await events()).length]).toEqual([
      { ok: false, error: { kind: "NotConfirmed" } },
      0,
    ]);
  });

  it("refuses an interview Paul dismissed", async () => {
    const detectionId = await detect();
    await decideInterview(db, { candidateId, detectionId, decision: "dismissed" });
    expect(await propose(detectionId)).toEqual({ ok: false, error: { kind: "NotConfirmed" } });
  });

  it("refuses a detection a reschedule replaced", async () => {
    const detectionId = await confirmed();
    await detect({ start: at("2026-12-02T15:00:00Z"), end: at("2026-12-02T16:00:00Z") });
    expect(await propose(detectionId)).toEqual({ ok: false, error: { kind: "Superseded" } });
  });

  it("refuses an unknown id and another candidate's detection", async () => {
    const detectionId = await confirmed();
    const other = await seedApplication(db, "submitted");
    expect([
      await propose("not-a-uuid"),
      await propose("00000000-0000-4000-8000-000000000000"),
      await proposeInterviewPrep(db, {
        candidateId: CandidateId.parse(other.candidateId),
        detectionId,
        request: request(),
      }),
    ]).toEqual([
      { ok: false, error: { kind: "UnknownDetection" } },
      { ok: false, error: { kind: "UnknownDetection" } },
      { ok: false, error: { kind: "UnknownDetection" } },
    ]);
  });

  it("refuses once the interview has started, storing nothing", async () => {
    const detectionId = await confirmed();
    expect([await propose(detectionId, { now: START }), (await events()).length]).toEqual([
      { ok: false, error: { kind: "InterviewStarted" } },
      0,
    ]);
  });

  it("refuses busy time that ends before it starts", async () => {
    const detectionId = await confirmed();
    const busy = [{ start: at("2026-11-30T10:00:00Z"), end: at("2026-11-30T09:00:00Z") }];
    expect(await propose(detectionId, { busy })).toEqual({
      ok: false,
      error: { kind: "InvalidInput", fields: ["busy"] },
    });
  });

  it("refuses bad working hours, an unknown zone and an invalid date by field name", async () => {
    const detectionId = await confirmed();
    expect([
      await propose(detectionId, { workingHours: { start: 1020, end: 540 } }),
      await propose(detectionId, { timeZone: "Mars/Olympus" }),
      await propose(detectionId, { now: new Date(Number.NaN) }),
      (await db.select().from(interviewPrepProposal)).length,
    ]).toEqual([
      { ok: false, error: { kind: "InvalidInput", fields: ["workingHours"] } },
      { ok: false, error: { kind: "InvalidInput", fields: ["timeZone"] } },
      { ok: false, error: { kind: "InvalidInput", fields: ["now"] } },
      0,
    ]);
  });
});

describe("readPrepProposal", () => {
  it("gives null before a proposal and the stored one after", async () => {
    const detectionId = await confirmed();
    const before = await readPrepProposal(db, candidateId, detectionId);
    const result = await propose(detectionId);
    if (!result.ok) throw new Error(result.error.kind);
    expect([before, await readPrepProposal(db, candidateId, detectionId)]).toEqual([
      null,
      result.value.proposal,
    ]);
  });
});

describe("prepReason", () => {
  it("words one block and a warm-up", () => {
    expect(prepReason(1, true)).toBe("Proposed 1 prep block and a warm-up for your interview");
  });
});

describe("the prep tables", () => {
  it("refuse changes, deletes, truncation and bad rows", async () => {
    const detectionId = await confirmed();
    const result = await propose(detectionId);
    if (!result.ok) throw new Error(result.error.kind);
    const proposalId = result.value.proposal.proposalId;
    expect([
      await sqlState(db.update(interviewPrepProposal).set({ missingPrep: 1 })),
      await sqlState(db.delete(interviewPrepProposal)),
      await sqlState(db.update(interviewPrepBlock).set({ kind: "prep" })),
      await sqlState(db.delete(interviewPrepBlock)),
      await sqlState(db.execute(sql`truncate interview_prep_block, interview_prep_proposal`)),
      await sqlState(
        db.insert(interviewPrepBlock).values({
          candidateId,
          proposalId,
          kind: "nap",
          startsAt: at("2026-11-29T10:00:00Z"),
          endsAt: at("2026-11-29T10:45:00Z"),
        }),
      ),
      await sqlState(
        db.insert(interviewPrepBlock).values({
          candidateId,
          proposalId,
          kind: "prep",
          startsAt: at("2026-11-29T10:45:00Z"),
          endsAt: at("2026-11-29T10:00:00Z"),
        }),
      ),
      // A second proposal for the same detection, and a second block at the same start.
      await sqlState(
        db
          .insert(interviewPrepProposal)
          .values({ candidateId, detectionId, missingPrep: 0, warmUpMissing: false }),
      ),
      await sqlState(
        db.insert(interviewPrepBlock).values({
          candidateId,
          proposalId,
          kind: "prep",
          startsAt: at("2026-11-30T09:00:00Z"),
          endsAt: at("2026-11-30T09:45:00Z"),
        }),
      ),
    ]).toEqual([
      RESTRICT_VIOLATION,
      RESTRICT_VIOLATION,
      RESTRICT_VIOLATION,
      RESTRICT_VIOLATION,
      RESTRICT_VIOLATION,
      CHECK_VIOLATION,
      CHECK_VIOLATION,
      UNIQUE_VIOLATION,
      UNIQUE_VIOLATION,
    ]);
  });
});
