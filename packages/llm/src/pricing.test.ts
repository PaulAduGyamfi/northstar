import { describe, expect, it } from "vitest";
import { costUsd } from "./pricing.js";

describe("costUsd", () => {
  it("prices Opus 5.5 input, output, cache reads and cache writes per million tokens", () => {
    // 1,000 in × $4 + 500 out × $20 + 10,000 cache read × $0.20 + 2,000 cache write × $5 (per M)
    const cost = costUsd("claude-opus-5-5", {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 10000,
      cacheWriteTokens: 2000,
    });
    expect(cost).toBe(0.026);
  });

  it("prices Sonnet 5.5 at its own rates", () => {
    const cost = costUsd("claude-sonnet-5-5", {
      inputTokens: 1000000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cost).toBe(2);
  });

  it("returns null for a model with no known price instead of guessing", () => {
    const cost = costUsd("claude-unknown-9", {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cost).toBeNull();
  });
});
