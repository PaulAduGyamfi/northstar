import type { CandidateId } from "@northstar/domain";
import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { llmSpend } from "./resilience-schema.js";

// LLM spend (NS-176 slice 2, RES-009, ADR-0021): the only writer of llm_spend, and the sums the
// spend cap reads. Route names and amounts only. No domain event per call: the llm.call span
// already carries the cost.

const ROUTE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MICRO = 1_000_000;

// Stores one reply's cost. A bad route name or amount is a bug in the caller, so it throws.
export async function recordLlmSpend(
  db: Db,
  input: { candidateId: CandidateId; route: string; costUsd: number },
): Promise<void> {
  if (!ROUTE.test(input.route) || input.route.length > 64)
    throw new Error("recordLlmSpend: bad route name");
  if (!Number.isFinite(input.costUsd) || input.costUsd < 0)
    throw new Error("recordLlmSpend: bad amount");
  await db.insert(llmSpend).values({
    candidateId: input.candidateId,
    route: input.route,
    costMicroUsd: Math.round(input.costUsd * MICRO),
  });
}

// Spend so far today and this month, in US dollars, by the UTC calendar of `now`.
export async function readLlmSpend(
  db: Db,
  candidateId: CandidateId,
  now: Date,
): Promise<{ todayUsd: number; monthUsd: number }> {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [row] = await db
    .select({
      today: sql<string>`coalesce(sum(${llmSpend.costMicroUsd}) filter (where ${llmSpend.spentAt} >= ${day}), 0)`,
      month: sql<string>`coalesce(sum(${llmSpend.costMicroUsd}), 0)`,
    })
    .from(llmSpend)
    .where(and(eq(llmSpend.candidateId, candidateId), gte(llmSpend.spentAt, month)));
  return {
    todayUsd: Number(row?.today ?? 0) / MICRO,
    monthUsd: Number(row?.month ?? 0) / MICRO,
  };
}

// The spend meter the LLM gateway takes (packages/llm's SpendMeter, by shape: this package can't
// import it), on the stored spend. `candidate` is a function so an entry point that finds its
// candidate lazily (the API) can pass its lookup.
export function dbSpendMeter(
  db: Db,
  candidate: () => CandidateId | Promise<CandidateId>,
): {
  spent: () => Promise<{ todayUsd: number; monthUsd: number }>;
  record: (route: string, costUsd: number) => Promise<void>;
} {
  return {
    spent: async () => readLlmSpend(db, await candidate(), new Date()),
    record: async (route, costUsd) =>
      recordLlmSpend(db, { candidateId: await candidate(), route, costUsd }),
  };
}
