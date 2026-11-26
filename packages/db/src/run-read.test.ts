import { randomUUID } from "node:crypto";
import { CandidateId, feedLine } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { MAX_RUN_STEPS, readRun } from "./run-read.js";
import { candidate, domainEvent } from "./schema.js";
import { createTestDb } from "./test/pglite.js";

// The run inspector's read (NS-154, OBS-003) on in-process PGlite. Synthetic events only.
const T0 = new Date("2026-11-26T09:00:00.000Z");
const TRACE = "0af7651916cd43dd8448eb211c80319c";
const OTHER_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";

const CALL = {
  route: "job-extract",
  promptId: "job-extract",
  promptVersion: 2,
  modelRequested: "claude-opus-5-5",
  modelServed: "claude-opus-5-5",
  effort: "medium",
  inputTokens: 1200,
  outputTokens: 300,
  cacheReadTokens: 800,
  cacheWriteTokens: 0,
  latencyMs: 2100,
  costUsd: 0.0123,
  stopReason: "end_turn",
  refusalCategory: null,
  fallbackUsed: false,
};

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let otherId: CandidateId;

async function addCandidate(): Promise<CandidateId> {
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  return CandidateId.parse(c.id);
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  candidateId = await addCandidate();
  otherId = await addCandidate();
});

afterEach(async () => {
  await close();
});

// Writes one event and returns its log position.
async function event(input: {
  who?: CandidateId;
  traceId: string | null;
  type?: string;
  payload?: Record<string, unknown>;
  atMs?: number;
}): Promise<bigint> {
  const [row] = await db
    .insert(domainEvent)
    .values({
      id: randomUUID(),
      candidateId: input.who ?? candidateId,
      aggregate: "job:00000000-0000-4000-8000-000000000001",
      type: input.type ?? "job.added",
      actor: "system",
      reason: "",
      inputsSummary: "",
      payload: input.payload ?? {},
      links: [],
      traceId: input.traceId,
      idempotencyKey: randomUUID(),
      occurredAt: new Date(T0.getTime() + (input.atMs ?? 0)),
    })
    .returning({ position: domainEvent.position });
  if (!row) throw new Error("no event");
  return row.position;
}

describe("readRun", () => {
  it("returns null for a position the candidate has no event at", async () => {
    const theirs = await event({ who: otherId, traceId: TRACE });
    expect([await readRun(db, candidateId, theirs), await readRun(db, candidateId, 999n)]).toEqual([
      null,
      null,
    ]);
  });

  it("treats an event without a trace as a run of one step", async () => {
    const p = await event({ traceId: null });
    await event({ traceId: null, atMs: 10 });
    const run = await readRun(db, candidateId, p);
    expect(run?.steps.map((s) => s.position)).toEqual([p]);
    expect(run?.truncated).toBe(false);
  });

  it("gathers the candidate's events with the same trace, oldest first, with offsets", async () => {
    const a = await event({ traceId: TRACE, atMs: 0 });
    await event({ traceId: OTHER_TRACE, atMs: 50 });
    await event({ who: otherId, traceId: TRACE, atMs: 60 });
    const b = await event({ traceId: TRACE, type: "job.scored", atMs: 2500 });
    const run = await readRun(db, candidateId, b);
    expect(run?.steps.map((s) => [s.position, s.type, s.offsetMs])).toEqual([
      [a, "job.added", 0],
      [b, "job.scored", 2500],
    ]);
    expect([run?.totals.steps, run?.totals.durationMs]).toEqual([2, 2500]);
  });

  it("copies a step's LLM call field by field and never anything else from the payload", async () => {
    const p = await event({
      traceId: TRACE,
      payload: {
        title: "Synthetic Job Title",
        call: { ...CALL, prompt: "secret prompt text", output: "model reply" },
      },
    });
    const run = await readRun(db, candidateId, p);
    expect(run?.steps[0]?.call).toEqual(CALL);
    expect(JSON.stringify(run, (_k, v) => (typeof v === "bigint" ? String(v) : v))).not.toMatch(
      /secret prompt|model reply|Synthetic Job Title/,
    );
  });

  it("gives no call for a payload whose call isn't a call record", async () => {
    const p = await event({ traceId: TRACE, payload: { call: { route: 7 } } });
    const q = await event({ traceId: TRACE, payload: { call: null } });
    const run = await readRun(db, candidateId, q);
    expect(run?.steps.map((s) => [s.position, s.call])).toEqual([
      [p, null],
      [q, null],
    ]);
  });

  it("adds up tokens and known costs, and counts calls without a price", async () => {
    await event({ traceId: TRACE, payload: { call: CALL } });
    await event({ traceId: TRACE, payload: { call: { ...CALL, costUsd: 0.0077 } } });
    const p = await event({ traceId: TRACE, payload: { call: { ...CALL, costUsd: null } } });
    const run = await readRun(db, candidateId, p);
    expect(run?.totals).toEqual({
      steps: 3,
      calls: 3,
      inputTokens: 3600,
      outputTokens: 900,
      costUsd: 0.02,
      unpricedCalls: 1,
      durationMs: 0,
    });
  });

  it("shows each step's feed line from feedLine, never stored text", async () => {
    const payload = { from: "discovered", to: "scored" };
    const p = await event({ traceId: null, type: "application.scored", payload });
    const run = await readRun(db, candidateId, p);
    expect(run?.steps[0]?.line).toBe(
      feedLine({ type: "application.scored", actor: "system", reason: "", payload }),
    );
  });

  it("keeps the clicked event in view when a run is cut, with up to half the steps before it", async () => {
    const positions: bigint[] = [];
    for (let i = 0; i < MAX_RUN_STEPS + 50; i++) {
      positions.push(await event({ traceId: TRACE, atMs: i }));
    }
    // The 221st of 250: the 100 steps up to it and the 29 after it are shown.
    const clicked = positions[220] ?? 0n;
    const run = await readRun(db, candidateId, clicked);
    const shown = run?.steps.map((s) => s.position) ?? [];
    expect([shown.length, shown[0], shown.at(-1), shown.includes(clicked), run?.truncated]).toEqual(
      [129, positions[121], positions[249], true, true],
    );
  }, 30_000);

  it(`shows at most ${MAX_RUN_STEPS} steps`, async () => {
    const positions: bigint[] = [];
    for (let i = 0; i < MAX_RUN_STEPS + 50; i++) {
      positions.push(await event({ traceId: TRACE, atMs: i }));
    }
    const run = await readRun(db, candidateId, positions[120] ?? 0n);
    expect([run?.steps.length, run?.truncated]).toEqual([MAX_RUN_STEPS, true]);
  }, 30_000);
});
