import type { RunView } from "@northstar/db";
import { z } from "zod";
import { type AnyEndpoint, endpoint } from "./endpoint.js";
// The feed's log position check (a bigint within Postgres's range), shared so both agree.
import { Position } from "./system.js";

// The run inspector (NS-154, OBS-003): the steps, timings and LLM calls behind one feed line.
// Session only. The database side is packages/db's readRun; bin.ts wires it, tests fake it.

export type RunPorts = {
  readRun: (position: bigint) => Promise<RunView | null>;
};

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

// Zod objects drop keys they don't name, so the answer carries only these fields.
const Run = z.object({
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

export function runEndpoints(ports: RunPorts): AnyEndpoint[] {
  const run = endpoint({
    method: "GET",
    path: "/feed/run",
    auth: "session",
    input: z.object({ position: Position }),
    output: Run,
    handler: async ({ position }) => {
      let view: RunView | null;
      try {
        view = await ports.readRun(position);
      } catch {
        // Postgres down: the button says the run can't be read right now.
        return { ok: false, status: 503, error: "unavailable" };
      }
      if (view === null) return { ok: false, status: 404, error: "not_found" };
      return {
        ok: true,
        body: {
          steps: view.steps.map((s) => ({
            ...s,
            position: s.position.toString(),
            occurredAt: s.occurredAt.toISOString(),
          })),
          totals: view.totals,
          truncated: view.truncated,
        },
      };
    },
  });
  return [run];
}
