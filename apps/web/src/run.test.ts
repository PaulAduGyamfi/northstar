import { describe, expect, it } from "vitest";
import { callLine, formatCost, formatDuration, RunBody, type RunCall, totalsLine } from "./run";

// The run inspector's plain words (NS-154). Synthetic calls only.
const CALL: RunCall = {
  route: "job-extract",
  promptId: "job-extract",
  promptVersion: 2,
  modelRequested: "claude-opus-5-5",
  modelServed: "claude-opus-5-5",
  effort: "medium",
  inputTokens: 1200,
  outputTokens: 300,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  latencyMs: 2100,
  costUsd: 0.0123,
  stopReason: "end_turn",
  refusalCategory: null,
  fallbackUsed: false,
};

describe("formatDuration", () => {
  it("uses milliseconds, seconds or minutes, whichever is shortest", () => {
    expect([0, 250, 2100, 60_000, 185_000].map(formatDuration)).toEqual([
      "0 ms",
      "250 ms",
      "2.1 s",
      "1 min",
      "3 min 5 s",
    ]);
  });
});

describe("formatCost", () => {
  it("shows four decimal places, and says so when the price is unknown", () => {
    expect([formatCost(0.0123), formatCost(0), formatCost(null)]).toEqual([
      "$0.0123",
      "$0.0000",
      "price unknown",
    ]);
  });
});

describe("callLine", () => {
  it("names the route, prompt version, model, tokens, time and cost", () => {
    expect(callLine(CALL)).toBe(
      "job-extract (prompt v2) · claude-opus-5-5 · 1,200 in / 300 out tokens · 2.1 s · $0.0123",
    );
  });

  it("says when a fallback model answered, a refusal, or an unusual stop", () => {
    expect([
      callLine({ ...CALL, modelServed: "claude-opus-4-8", fallbackUsed: true, costUsd: null }),
      callLine({ ...CALL, refusalCategory: "cyber", stopReason: "refusal" }),
      callLine({ ...CALL, stopReason: "max_tokens" }),
    ]).toEqual([
      "job-extract (prompt v2) · claude-opus-4-8 · 1,200 in / 300 out tokens · 2.1 s · price unknown · fallback from claude-opus-5-5",
      "job-extract (prompt v2) · claude-opus-5-5 · 1,200 in / 300 out tokens · 2.1 s · $0.0123 · refused (cyber)",
      "job-extract (prompt v2) · claude-opus-5-5 · 1,200 in / 300 out tokens · 2.1 s · $0.0123 · stopped: max_tokens",
    ]);
  });
});

describe("totalsLine", () => {
  const totals = {
    steps: 3,
    calls: 2,
    inputTokens: 2400,
    outputTokens: 600,
    costUsd: 0.0123,
    unpricedCalls: 1,
    durationMs: 4200,
  };

  it("adds up the run and counts calls without a price", () => {
    expect(totalsLine(totals)).toBe(
      "3 steps over 4.2 s · 2 model calls · 2,400 in / 600 out tokens · $0.0123 (1 without a known price)",
    );
  });

  it("says there were no model calls when there were none", () => {
    expect(totalsLine({ ...totals, steps: 1, calls: 0, durationMs: 0 })).toBe(
      "1 step over 0 ms · no model calls",
    );
  });
});

describe("RunBody", () => {
  it("drops fields the API answer didn't promise", () => {
    const parsed = RunBody.parse({
      steps: [
        {
          position: "7",
          occurredAt: "2026-11-26T09:00:00.000Z",
          type: "job.added",
          actor: "system",
          line: "Added a job.",
          offsetMs: 0,
          call: { ...CALL, prompt: "secret prompt text" },
        },
      ],
      totals: {
        steps: 1,
        calls: 1,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        unpricedCalls: 0,
        durationMs: 0,
      },
      truncated: false,
    } as unknown);
    expect(JSON.stringify(parsed)).not.toContain("secret prompt");
  });
});
