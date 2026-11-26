import { type CandidateId, feedLine } from "@northstar/domain";
import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import type { Db } from "./db.js";
import { inSpan } from "./resilience-event.js";
import { domainEvent } from "./schema.js";

// The run inspector (NS-154, OBS-003): the events behind one feed line, collected by its trace,
// with the LLM calls they carry. Read-only. Text comes only from feedLine, and a call is copied
// field by field from the gateway's call record (ids, versions and numbers), so nothing else a
// payload holds ever leaves here.

// A run larger than this is cut (the view says so): enough for any step list Paul reads. The cut
// keeps the clicked event in view: up to half at or before it, the rest after it.
export const MAX_RUN_STEPS = 200;
const HALF = MAX_RUN_STEPS / 2;

// The LLM call record's fields (packages/llm, CallRecord), as stored in an event's `payload.call`.
export type RunCall = {
  route: string;
  promptId: string;
  promptVersion: number;
  modelRequested: string;
  modelServed: string;
  effort: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
  costUsd: number | null;
  stopReason: string | null;
  refusalCategory: string | null;
  fallbackUsed: boolean;
};

export type RunStep = {
  position: bigint;
  occurredAt: Date;
  type: string;
  actor: string;
  line: string;
  // Milliseconds since the run's first step.
  offsetMs: number;
  call: RunCall | null;
};

export type RunTotals = {
  steps: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  // The sum of the calls with a known price; unpricedCalls says how many had none.
  costUsd: number;
  unpricedCalls: number;
  durationMs: number;
};

export type RunView = { steps: RunStep[]; totals: RunTotals; truncated: boolean };

const isString = (v: unknown): v is string => typeof v === "string";
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isNullableString = (v: unknown): v is string | null => v === null || isString(v);

// The stored call, or null when the payload holds none or it isn't the gateway's shape (an older
// or foreign payload): a wrong field is never passed on.
export function pickCall(value: unknown): RunCall | null {
  if (value === null || typeof value !== "object") return null;
  const c = value as Record<string, unknown>;
  const ok =
    isString(c.route) &&
    isString(c.promptId) &&
    Number.isInteger(c.promptVersion) &&
    isCount(c.promptVersion) &&
    isString(c.modelRequested) &&
    isString(c.modelServed) &&
    isString(c.effort) &&
    isCount(c.inputTokens) &&
    isCount(c.outputTokens) &&
    isCount(c.cacheReadTokens) &&
    isCount(c.cacheWriteTokens) &&
    isCount(c.latencyMs) &&
    (c.costUsd === null || isCount(c.costUsd)) &&
    isNullableString(c.stopReason) &&
    isNullableString(c.refusalCategory) &&
    typeof c.fallbackUsed === "boolean";
  if (!ok) return null;
  // Field by field, never a spread: extra fields (prompt text, output) stay behind.
  return {
    route: c.route as string,
    promptId: c.promptId as string,
    promptVersion: c.promptVersion as number,
    modelRequested: c.modelRequested as string,
    modelServed: c.modelServed as string,
    effort: c.effort as string,
    inputTokens: c.inputTokens as number,
    outputTokens: c.outputTokens as number,
    cacheReadTokens: c.cacheReadTokens as number,
    cacheWriteTokens: c.cacheWriteTokens as number,
    latencyMs: c.latencyMs as number,
    costUsd: c.costUsd as number | null,
    stopReason: c.stopReason as string | null,
    refusalCategory: c.refusalCategory as string | null,
    fallbackUsed: c.fallbackUsed as boolean,
  };
}

function totalsOf(steps: RunStep[]): RunTotals {
  const calls = steps.flatMap((s) => (s.call ? [s.call] : []));
  // Summed in micro-dollars so the total doesn't drift by floating-point error.
  const micros = calls.reduce((sum, c) => sum + Math.round((c.costUsd ?? 0) * 1e6), 0);
  return {
    steps: steps.length,
    calls: calls.length,
    inputTokens: calls.reduce((sum, c) => sum + c.inputTokens, 0),
    outputTokens: calls.reduce((sum, c) => sum + c.outputTokens, 0),
    costUsd: micros / 1e6,
    unpricedCalls: calls.filter((c) => c.costUsd === null).length,
    durationMs: steps.at(-1)?.offsetMs ?? 0,
  };
}

const columns = {
  position: domainEvent.position,
  occurredAt: domainEvent.occurredAt,
  type: domainEvent.type,
  actor: domainEvent.actor,
  reason: domainEvent.reason,
  payload: domainEvent.payload,
  traceId: domainEvent.traceId,
};

// The run behind the candidate's event at `position`, or null when there is no such event. An
// event without a trace is a run of one step.
export async function readRun(
  db: Db,
  candidateId: CandidateId,
  position: bigint,
): Promise<RunView | null> {
  return inSpan("run.read", {}, async (span) => {
    const [anchor] = await db
      .select(columns)
      .from(domainEvent)
      .where(and(eq(domainEvent.candidateId, candidateId), eq(domainEvent.position, position)));
    if (!anchor) return null;
    let shown = [anchor];
    let truncated = false;
    if (anchor.traceId !== null) {
      const sameTrace = and(
        eq(domainEvent.candidateId, candidateId),
        eq(domainEvent.traceId, anchor.traceId),
      );
      // One more than shown on each side, to know whether the run was cut there.
      const before = await db
        .select(columns)
        .from(domainEvent)
        .where(and(sameTrace, lte(domainEvent.position, position)))
        .orderBy(desc(domainEvent.position))
        .limit(HALF + 1);
      const after = await db
        .select(columns)
        .from(domainEvent)
        .where(and(sameTrace, gt(domainEvent.position, position)))
        .orderBy(asc(domainEvent.position))
        .limit(HALF + 1);
      truncated = before.length > HALF || after.length > HALF;
      shown = [...before.slice(0, HALF).reverse(), ...after.slice(0, HALF)];
    }
    const start = shown[0]?.occurredAt.getTime() ?? 0;
    const steps: RunStep[] = shown.map((r) => ({
      position: r.position,
      occurredAt: r.occurredAt,
      type: r.type,
      actor: r.actor,
      line: feedLine({ type: r.type, actor: r.actor, reason: r.reason, payload: r.payload }),
      offsetMs: r.occurredAt.getTime() - start,
      call: pickCall(r.payload.call),
    }));
    span.setAttribute("northstar.run.steps", steps.length);
    return { steps, totals: totalsOf(steps), truncated };
  });
}
