import type { CandidateId } from "@northstar/domain";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "./db.js";
import { fitScore } from "./fit-schema.js";
import { inSpan } from "./resilience-event.js";

// The "why" behind the jobs page's scores (NS-130 slice 11, UX-014), read-only: each job's newest
// score's evidence, the same newest row listJobs shows (by scored time). The
// evidence holds atom ids and Paul's own dealbreaker words, so the caller (apps/api jobs.ts) picks
// what leaves the API field by field.

// The page lists at most 100 jobs (JOBS_PAGE_MAX); a larger ask is refused, never truncated.
export const FIT_WHY_MAX = 100;

export type FitWhy = { evidence: Record<string, unknown> };

export async function readFitWhy(
  db: Db,
  input: { candidateId: CandidateId; jobIds: string[] },
): Promise<Map<string, FitWhy>> {
  if (input.jobIds.length > FIT_WHY_MAX) throw new Error("too many job ids");
  if (input.jobIds.length === 0) return new Map();
  return inSpan("db.fit.why_read", { "northstar.fit.jobs": input.jobIds.length }, async () => {
    const rows = await db
      .selectDistinctOn([fitScore.jobId], {
        jobId: fitScore.jobId,
        evidence: fitScore.evidence,
      })
      .from(fitScore)
      .where(
        and(eq(fitScore.candidateId, input.candidateId), inArray(fitScore.jobId, input.jobIds)),
      )
      // Newest first within each job, as listJobs picks the score it shows.
      .orderBy(fitScore.jobId, desc(fitScore.scoredAt));
    return new Map(rows.map((r) => [r.jobId, { evidence: r.evidence as FitWhy["evidence"] }]));
  });
}
