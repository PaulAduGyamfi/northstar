import { type Db, findSimilarJobs, recordDuplicateSuggestion } from "@northstar/db";
import type { CandidateId } from "@northstar/domain";

// Duplicate suggestions from job embeddings (NS-129 slice 2, SRC-006, ADR-0033). Two saved jobs
// whose current vectors are at least `threshold` alike get one suggestion for Paul to check. A
// suggestion never merges, edits or deletes a job: findDuplicate stays the only merge, and any
// two separate jobs are ones it already kept apart.

// The most suggestions one job can raise in a pass, so one generic posting can't flood the feed.
export const MAX_SUGGESTIONS_PER_JOB = 5;

export type SuggestResult = { suggested: number; existing: number };

// The threshold has no default: slice 3 measures it on a labelled synthetic set before anything
// is turned on, and the caller passes it.
export async function suggestDuplicates(
  db: Db,
  candidateId: CandidateId,
  jobId: string,
  opts: { threshold: number },
): Promise<SuggestResult> {
  const similar = await findSimilarJobs(db, {
    candidateId,
    jobId,
    minSimilarity: opts.threshold,
    limit: MAX_SUGGESTIONS_PER_JOB,
  });
  const result: SuggestResult = { suggested: 0, existing: 0 };
  for (const match of similar) {
    // A cosine of two float vectors can round a hair above 1.
    const similarity = Math.min(1, Math.max(0, match.similarity));
    const { status } = await recordDuplicateSuggestion(db, {
      candidateId,
      jobIds: [jobId, match.jobId],
      similarity,
    });
    if (status === "stored") result.suggested += 1;
    else result.existing += 1;
  }
  return result;
}
