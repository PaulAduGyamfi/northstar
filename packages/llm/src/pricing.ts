// Token prices in US cents per million tokens. Whole cents keep the arithmetic exact.
// Source: Anthropic API reference model table (claude-api skill, cached 2026-11-03).
// Cache write is assumed to cost 1.25x input (5-minute TTL); spec NS-106 open question 4.
// Update this table by hand when prices change (ADR-0013).
const CENTS_PER_MILLION: Readonly<
  Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>
> = {
  "claude-opus-5-5": { input: 400, output: 2000, cacheRead: 20, cacheWrite: 500 },
  "claude-sonnet-5-5": { input: 200, output: 1000, cacheRead: 10, cacheWrite: 250 },
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

// Cost of one call in USD, or null for a model with no known price (never a guess).
export function costUsd(model: string, usage: TokenUsage): number | null {
  const price = CENTS_PER_MILLION[model];
  if (!price) return null;
  // tokens × cents-per-million is an integer number of "millionths of a cent".
  const millionthsOfCent =
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadTokens * price.cacheRead +
    usage.cacheWriteTokens * price.cacheWrite;
  return millionthsOfCent / 100_000_000;
}

// What a call would cost at the most expensive known model. The spend cap (NS-176, ADR-0021)
// meters an unpriced reply (a fallback model the API chose, a new id) at this, never at zero, so
// a model missing from the table can only over-count, never let spend through unmetered.
export function ceilingCostUsd(usage: TokenUsage): number {
  return Math.max(...Object.keys(CENTS_PER_MILLION).map((m) => costUsd(m, usage) ?? 0));
}
