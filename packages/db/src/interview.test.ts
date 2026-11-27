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
import { interviewDecision, interviewDetection } from "./interview-schema.js";
import {
  decideInterview,
  listInterviews,
  MAX_DETECTION_VERSIONS,
  MAX_DETECTIONS_PER_DAY,
  recordInterviewDetection,
} from "./interview-write.js";
import { application, domainEvent } from "./schema.js";
import { createTestDb, seedApplication, sqlState } from "./test/pglite.js";

// Detected interviews and Paul's decisions (NS-240 slice 2) on PGlite. Invented event ids only.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";

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

const START = new Date("2026-12-01T15:00:00Z");
const END = new Date("2026-12-01T16:00:00Z");
const detection = (over: Record<string, unknown> = {}) => ({
  applicationId,
  calendarEventId: "a1b2c3d4e5f6g7h8",
  format: "technical",
  start: START,
  end: END,
  interviewerCount: 2,
  ...over,
});

const record = (over: Record<string, unknown> = {}) =>
  recordInterviewDetection(db, { candidateId, detection: detection(over) });

const events = (type: string) => db.select().from(domainEvent).where(eq(domainEvent.type, type));

describe("recordInterviewDetection", () => {
  it("stores a detection once with one interview.detected event on the application", async () => {
    const first = await record();
    const again = await record();
    if (!first.ok || !again.ok) throw new Error("not recorded");
    expect([first.value.recorded, again.value.recorded]).toEqual([true, false]);
    expect(again.value.detectionId).toBe(first.value.detectionId);
    const [event, ...rest] = await events("interview.detected");
    expect(rest).toEqual([]);
    expect(event?.aggregate).toBe(`application:${applicationId}`);
    expect(event?.reason).toBe("Found a possible technical interview on your calendar: confirm it");
    expect(event?.payload).toEqual({
      applicationId,
      detectionId: first.value.detectionId,
      version: 1,
      format: "technical",
      startsAt: START.toISOString(),
      endsAt: END.toISOString(),
      interviewerCount: 2,
    });
  });

  it("stores a rescheduled event as a new current detection, leaving the old time out of the list", async () => {
    await record();
    const moved = await record({
      start: new Date("2026-12-02T15:00:00Z"),
      end: new Date("2026-12-02T16:00:00Z"),
    });
    if (!moved.ok) throw new Error("not recorded");
    const listed = await listInterviews(db, candidateId);
    expect(listed.map((i) => [i.detectionId, i.start.toISOString(), i.decision])).toEqual([
      [moved.value.detectionId, "2026-12-02T15:00:00.000Z", null],
    ]);
  });

  it("refuses another candidate's application and stores nothing", async () => {
    const other = await seedApplication(db, "submitted");
    const result = await record({ applicationId: other.applicationId });
    expect(result).toEqual({ ok: false, error: { kind: "UnknownApplication" } });
    expect(await db.select().from(interviewDetection)).toEqual([]);
  });

  it("refuses a detection that ends before it starts, an unknown format or a strange event id", async () => {
    const results = await Promise.all([
      record({ end: START }),
      record({ format: "lunch" }),
      record({ calendarEventId: "has spaces/and slashes" }),
      record({ title: "Interview with Acme" }),
    ]);
    expect(results.map((r) => (r.ok ? "stored" : r.error))).toEqual([
      { kind: "InvalidDetection", fields: ["end"] },
      { kind: "InvalidDetection", fields: ["format"] },
      { kind: "InvalidDetection", fields: ["calendarEventId"] },
      { kind: "InvalidDetection", fields: ["detection"] },
    ]);
  });
});

describe("recordInterviewDetection's versions and limits", () => {
  const at = (day: number) => ({
    start: new Date(`2026-12-0${day}T15:00:00Z`),
    end: new Date(`2026-12-0${day}T16:00:00Z`),
  });

  it("keeps the time current when an event moves back to an earlier time", async () => {
    await record(at(1));
    await record(at(2));
    const back = await record(at(1));
    if (!back.ok) throw new Error("not recorded");
    expect(back.value.recorded).toBe(true);
    const listed = await listInterviews(db, candidateId);
    expect(listed.map((i) => [i.detectionId, i.start.toISOString()])).toEqual([
      [back.value.detectionId, "2026-12-01T15:00:00.000Z"],
    ]);
    expect((await events("interview.rescheduled")).map((e) => e.reason)).toEqual([
      "A possible technical interview on your calendar moved: confirm the new time",
      "A possible technical interview on your calendar moved: confirm the new time",
    ]);
  });

  it("stores nothing more for an event Paul dismissed, even when it moves", async () => {
    const first = await record(at(1));
    if (!first.ok) throw new Error("not recorded");
    await decideInterview(db, {
      candidateId,
      detectionId: first.value.detectionId,
      decision: "dismissed",
    });
    const moved = await record(at(2));
    expect(moved).toEqual({
      ok: true,
      value: { recorded: false, detectionId: first.value.detectionId },
    });
    expect(await db.select().from(interviewDetection)).toHaveLength(1);
  });

  it(`stops after ${MAX_DETECTION_VERSIONS} versions of one event`, async () => {
    for (let v = 1; v <= MAX_DETECTION_VERSIONS; v++) {
      const r = await record({ interviewerCount: v });
      expect(r.ok && r.value.recorded).toBe(true);
    }
    expect(await record({ interviewerCount: 0 })).toEqual({
      ok: false,
      error: { kind: "TooManyChanges" },
    });
  });

  it(`stops after ${MAX_DETECTIONS_PER_DAY} new detections in a day`, async () => {
    for (let n = 0; n < MAX_DETECTIONS_PER_DAY; n++) {
      const r = await record({ calendarEventId: `event${n}` });
      expect(r.ok && r.value.recorded).toBe(true);
    }
    expect(await record({ calendarEventId: "oneTooMany" })).toEqual({
      ok: false,
      error: { kind: "DailyLimit" },
    });
  });

  it("refuses a decision on a detection a reschedule replaced", async () => {
    const old = await record(at(1));
    await record(at(2));
    if (!old.ok) throw new Error("not recorded");
    expect(
      await decideInterview(db, {
        candidateId,
        detectionId: old.value.detectionId,
        decision: "confirmed",
      }),
    ).toEqual({ ok: false, error: { kind: "Superseded" } });
  });
});

describe("decideInterview", () => {
  it("records Paul's confirm once, never moves the application's status, and refuses a dismiss after", async () => {
    const stored = await record();
    if (!stored.ok) throw new Error("not recorded");
    const decide = (decision: "confirmed" | "dismissed") =>
      decideInterview(db, { candidateId, detectionId: stored.value.detectionId, decision });
    expect([
      await decide("confirmed"),
      await decide("confirmed"),
      await decide("dismissed"),
    ]).toEqual([
      { ok: true, value: { recorded: true } },
      { ok: true, value: { recorded: false } },
      { ok: false, error: { kind: "AlreadyDecided", decision: "confirmed" } },
    ]);
    const [app] = await db.select({ status: application.status }).from(application);
    expect(app?.status).toBe("submitted");
    const confirmed = await events("interview.confirmed");
    expect(confirmed.map((e) => [e.actor, e.reason])).toEqual([
      ["user", "You confirmed an interview from your calendar"],
    ]);
    expect((await listInterviews(db, candidateId)).map((i) => i.decision)).toEqual(["confirmed"]);
  });

  it("refuses another candidate's detection and an id that isn't one", async () => {
    const stored = await record();
    if (!stored.ok) throw new Error("not recorded");
    const other = await seedApplication(db, "submitted");
    const results = await Promise.all([
      decideInterview(db, {
        candidateId: CandidateId.parse(other.candidateId),
        detectionId: stored.value.detectionId,
        decision: "dismissed",
      }),
      decideInterview(db, { candidateId, detectionId: "not-a-uuid", decision: "dismissed" }),
    ]);
    expect(results).toEqual([
      { ok: false, error: { kind: "UnknownDetection" } },
      { ok: false, error: { kind: "UnknownDetection" } },
    ]);
    expect(await db.select().from(interviewDecision)).toEqual([]);
  });
});

describe("the interview tables", () => {
  it("refuse UPDATE, DELETE and TRUNCATE, and a row outside their checks", async () => {
    const stored = await record();
    if (!stored.ok) throw new Error("not recorded");
    await decideInterview(db, {
      candidateId,
      detectionId: stored.value.detectionId,
      decision: "confirmed",
    });
    expect([
      await sqlState(db.update(interviewDetection).set({ format: "other" })),
      await sqlState(db.delete(interviewDetection)),
      await sqlState(db.execute(sql`truncate interview_detection`)),
      await sqlState(db.update(interviewDecision).set({ decision: "dismissed" })),
      await sqlState(db.delete(interviewDecision)),
      await sqlState(db.execute(sql`truncate interview_decision`)),
      await sqlState(
        db.insert(interviewDecision).values({
          candidateId,
          detectionId: stored.value.detectionId,
          decision: "maybe",
        }),
      ),
      await sqlState(
        db.insert(interviewDetection).values({
          candidateId,
          applicationId,
          calendarEventId: "b1",
          format: "technical",
          startsAt: START,
          endsAt: END,
          interviewerCount: 99,
          version: 1,
        }),
      ),
    ]).toEqual([
      RESTRICT_VIOLATION,
      RESTRICT_VIOLATION,
      RESTRICT_VIOLATION,
      RESTRICT_VIOLATION,
      RESTRICT_VIOLATION,
      RESTRICT_VIOLATION,
      CHECK_VIOLATION,
      CHECK_VIOLATION,
    ]);
  });
});
