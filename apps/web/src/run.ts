import { z } from "zod";

// The run inspector (NS-154, OBS-003): the API's answer for the run behind a feed line, and the
// plain words it is shown in. Ids, versions and numbers only; the step lines come from the API's
// feedLine.

const Call = z.object({
  route: z.string(),
  promptId: z.string(),
  promptVersion: z.number(),
  modelRequested: z.string(),
  modelServed: z.string(),
  effort: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  latencyMs: z.number(),
  costUsd: z.number().nullable(),
  stopReason: z.string().nullable(),
  refusalCategory: z.string().nullable(),
  fallbackUsed: z.boolean(),
});
export type RunCall = z.infer<typeof Call>;

export const RunBody = z.object({
  steps: z.array(
    z.object({
      position: z.string(),
      occurredAt: z.string(),
      type: z.string(),
      actor: z.string(),
      line: z.string(),
      offsetMs: z.number(),
      call: Call.nullable(),
    }),
  ),
  totals: z.object({
    steps: z.number(),
    calls: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    costUsd: z.number(),
    unpricedCalls: z.number(),
    durationMs: z.number(),
  }),
  truncated: z.boolean(),
});
export type RunViewBody = z.infer<typeof RunBody>;

// A duration in the shortest plain form: "250 ms", "2.1 s", "3 min 5 s".
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

// A cost in dollars to four places (a call is often under a cent), or why there isn't one.
export function formatCost(costUsd: number | null): string {
  return costUsd === null ? "price unknown" : `$${costUsd.toFixed(4)}`;
}

const count = (n: number): string => n.toLocaleString("en-US");

// One LLM call in a line: route and prompt version, the model that answered, tokens, time, cost,
// and anything that went differently (a fallback model, a refusal, an unusual stop).
export function callLine(c: RunCall): string {
  const parts = [
    `${c.route} (prompt v${c.promptVersion})`,
    c.modelServed,
    `${count(c.inputTokens)} in / ${count(c.outputTokens)} out tokens`,
    formatDuration(c.latencyMs),
    formatCost(c.costUsd),
  ];
  if (c.fallbackUsed || c.modelServed !== c.modelRequested) {
    parts.push(`fallback from ${c.modelRequested}`);
  }
  if (c.refusalCategory !== null) parts.push(`refused (${c.refusalCategory})`);
  else if (c.stopReason !== null && c.stopReason !== "end_turn" && c.stopReason !== "tool_use") {
    parts.push(`stopped: ${c.stopReason}`);
  }
  return parts.join(" · ");
}

// The run's totals in one line.
export function totalsLine(t: RunViewBody["totals"]): string {
  const steps = `${t.steps} ${t.steps === 1 ? "step" : "steps"} over ${formatDuration(t.durationMs)}`;
  if (t.calls === 0) return `${steps} · no model calls`;
  const calls = `${t.calls} model ${t.calls === 1 ? "call" : "calls"}`;
  const tokens = `${count(t.inputTokens)} in / ${count(t.outputTokens)} out tokens`;
  const unpriced = t.unpricedCalls > 0 ? ` (${t.unpricedCalls} without a known price)` : "";
  return `${steps} · ${calls} · ${tokens} · ${formatCost(t.costUsd)}${unpriced}`;
}
