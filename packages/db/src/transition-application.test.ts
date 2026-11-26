import { ApplicationId, CandidateId } from "@northstar/domain";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { application, domainEvent } from "./schema.js";
import { createTestDb, type Seeded, seedApplication } from "./test/pglite.js";
import { type TransitionInput, transitionApplication } from "./transition-application.js";

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});

afterAll(() => {
  trace.disable();
});

let db: Db;
let close: () => Promise<void>;
let seeded: Seeded;

beforeEach(async () => {
  exporter.reset();
  ({ db, close } = await createTestDb());
  seeded = await seedApplication(db, "submitting");
});

afterEach(async () => {
  await close();
});

const NOW = new Date("2026-11-24T12:00:00.000Z");

const input = (overrides: Partial<TransitionInput> = {}): TransitionInput => ({
  candidateId: CandidateId.parse(seeded.candidateId),
  applicationId: ApplicationId.parse(seeded.applicationId),
  from: "submitting",
  to: "submitted",
  actor: "agent:apply",
  reason: "The ATS accepted the form",
  inputsSummary: "Package for Example Corp, Backend Engineer",
  links: [{ rel: "job", href: "https://jobs.example.com/backend-engineer" }],
  idempotencyKey: `application:${seeded.applicationId}:submit`,
  submittedVia: "approved",
  now: NOW,
  ...overrides,
});

const statusOf = async (id: string): Promise<string | undefined> => {
  const [row] = await db
    .select({ status: application.status })
    .from(application)
    .where(eq(application.id, id));
  return row?.status;
};

const eventCount = async (): Promise<number> => (await db.select().from(domainEvent)).length;

describe("transitionApplication", () => {
  it("moves the status and writes exactly one event with the OBS-001 fields", async () => {
    const result = await transitionApplication(db, input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.replayed).toBe(false);
    expect(result.value.event).toMatchObject({
      candidateId: seeded.candidateId,
      aggregate: `application:${seeded.applicationId}`,
      type: "application.submitted",
      actor: "agent:apply",
      reason: "The ATS accepted the form",
      inputsSummary: "Package for Example Corp, Backend Engineer",
      payload: { from: "submitting", to: "submitted" },
      links: [{ rel: "job", href: "https://jobs.example.com/backend-engineer" }],
      idempotencyKey: `application:${seeded.applicationId}:submit`,
      occurredAt: NOW,
    });
    expect(await statusOf(seeded.applicationId)).toBe("submitted");
    expect(await eventCount()).toBe(1);
  });

  it("refuses an illegal move and writes nothing", async () => {
    const result = await transitionApplication(db, input({ to: "offer" }));

    expect(result).toEqual({
      ok: false,
      error: { kind: "IllegalTransition", from: "submitting", to: "offer" },
    });
    expect(await statusOf(seeded.applicationId)).toBe("submitting");
    expect(await eventCount()).toBe(0);
  });

  it("running the same transition twice leaves one status change and one event", async () => {
    const first = await transitionApplication(db, input());
    const second = await transitionApplication(db, input());

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.replayed).toBe(true);
    expect(second.value.event).toEqual(first.value.event);
    expect(second.value.position).toBe(first.value.position);
    expect(await statusOf(seeded.applicationId)).toBe("submitted");
    expect(await eventCount()).toBe(1);
  });

  // PGlite has one connection, so this runs the two workers one after the other. It proves the
  // `status = from` guard; the concurrent replay re-check needs a real Postgres to exercise.
  it("a move from a status the application has already left gets StaleStatus and no event", async () => {
    await transitionApplication(db, input());
    const late = await transitionApplication(
      db,
      input({ to: "needs_human", idempotencyKey: "another-worker" }),
    );

    expect(late).toEqual({
      ok: false,
      error: {
        kind: "StaleStatus",
        applicationId: seeded.applicationId,
        expected: "submitting",
        actual: "submitted",
      },
    });
    expect(await eventCount()).toBe(1);
  });

  it("returns NotFound for an application the candidate does not have", async () => {
    const missing = "33333333-3333-4333-8333-333333333333";
    const result = await transitionApplication(
      db,
      input({ applicationId: ApplicationId.parse(missing), idempotencyKey: "missing" }),
    );

    expect(result).toEqual({ ok: false, error: { kind: "NotFound", applicationId: missing } });
    expect(await eventCount()).toBe(0);
  });

  it("refuses an idempotency key already used for a different move", async () => {
    await transitionApplication(db, input());
    const reused = await transitionApplication(db, input({ from: "submitted", to: "confirmed" }));

    expect(reused).toEqual({
      ok: false,
      error: {
        kind: "IdempotencyKeyReused",
        idempotencyKey: `application:${seeded.applicationId}:submit`,
      },
    });
    expect(await statusOf(seeded.applicationId)).toBe("submitted");
    expect(await eventCount()).toBe(1);
  });

  it("refuses a key already used for the same move with a different reason code (NS-218)", async () => {
    const withdraw = { to: "withdrawn" as const, submittedVia: undefined, idempotencyKey: "w1" };
    await transitionApplication(db, input({ ...withdraw, reasonCode: "posting_closed" }));
    const replayed = await transitionApplication(db, input({ ...withdraw, reasonCode: undefined }));

    expect(replayed).toEqual({
      ok: false,
      error: { kind: "IdempotencyKeyReused", idempotencyKey: "w1" },
    });
    expect(await eventCount()).toBe(1);
  });

  it("refuses an invalid event before writing anything", async () => {
    const result = await transitionApplication(db, input({ actor: "someone" }));

    expect(result).toEqual({ ok: false, error: { kind: "InvalidEvent", fields: ["actor"] } });
    expect(await statusOf(seeded.applicationId)).toBe("submitting");
    expect(await eventCount()).toBe(0);
  });

  it("leaves the status unchanged when the event cannot be written", async () => {
    // A test-only trigger makes the event insert fail after the status update has run. If the
    // two writes were not in one transaction, the status would stay changed with no event.
    await db.execute(sql`
      create function fail_event_insert() returns trigger language plpgsql as $$
      begin raise exception 'event insert failed on purpose'; end; $$`);
    await db.execute(sql`
      create trigger fail_event_insert before insert on domain_event
      for each row execute function fail_event_insert()`);

    await expect(transitionApplication(db, input())).rejects.toThrow();
    expect(await statusOf(seeded.applicationId)).toBe("submitting");
    expect(await eventCount()).toBe(0);
  });

  it("stores the trace id of the span the transition opened", async () => {
    const result = await transitionApplication(db, input());

    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("db.application.transition");
    expect(result.ok && result.value.event.traceId).toBe(span?.spanContext().traceId);
    expect(span?.attributes).toEqual({
      "northstar.application.id": seeded.applicationId,
      "northstar.status.from": "submitting",
      "northstar.status.to": "submitted",
      "northstar.idempotent_replay": false,
    });
  });

  it("marks the span as an error when the move is refused", async () => {
    await transitionApplication(db, input({ to: "offer" }));

    const [span] = exporter.getFinishedSpans();
    expect(span?.status).toEqual({ code: SpanStatusCode.ERROR, message: "IllegalTransition" });
  });
});

describe("how an application went out (INB-007, NS-188)", () => {
  it("refuses a move to submitted that doesn't say how it went out, and moves nothing", async () => {
    const result = await transitionApplication(db, input({ submittedVia: undefined }));
    expect([
      result.ok ? "moved" : result.error.kind,
      await statusOf(seeded.applicationId),
      await eventCount(),
    ]).toEqual(["MissingSubmittedVia", "submitting", 0]);
  });

  it("stores how it went out in the move's own event", async () => {
    const result = await transitionApplication(db, input({ submittedVia: "auto" }));
    expect(result.ok && result.value.event.payload).toEqual({
      from: "submitting",
      to: "submitted",
      submittedVia: "auto",
    });
  });

  it("adds nothing to a move that isn't to submitted", async () => {
    const result = await transitionApplication(
      db,
      input({ to: "needs_human", submittedVia: "auto", idempotencyKey: "x:needs_human" }),
    );
    expect(result.ok && result.value.event.payload).toEqual({
      from: "submitting",
      to: "needs_human",
    });
  });
});
