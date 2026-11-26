import { type Db, recordDeadLetter } from "@northstar/db";
import { CandidateId } from "@northstar/domain";
import { ApplicationFailure } from "@temporalio/common";
import { SWEEP_ATTEMPTS } from "../workflows/types.js";

// The stale-claim sweep's activities (NS-220): one pass of the Apply Gateway's sweepStaleClaims
// for one candidate (database only, no browser), and the dead letter for a pass that kept
// failing (RES-007, ADR-0007: never a silent drop).

// The gateway's sweep bound to its ports (sweepStaleClaims with dbSweepPorts(db)).
type Sweep = (candidateId: CandidateId) => Promise<string[]>;

// A candidate id crosses Temporal as JSON: checked again here. Bad input never improves.
function candidate(raw: string): CandidateId {
  const parsed = CandidateId.safeParse(raw);
  if (!parsed.success)
    throw ApplicationFailure.nonRetryable("candidateId is not a uuid", "InvalidInput");
  return parsed.data;
}

export function createSweepActivities(sweep: Sweep, db: Db) {
  return {
    // Returns how many claims the pass closed or repaired. A failure is thrown for the retry
    // policy: a repeated pass is safe, it finds only what is still stale.
    async sweepStaleClaims(args: { candidateId: string }): Promise<{ closed: number }> {
      const closed = await sweep(candidate(args.candidateId));
      return { closed: closed.length };
    },
    // Records a pass that failed all its attempts. `key` names the workflow run and pass, so a
    // retried call stores one letter.
    async recordSweepFailure(args: { candidateId: string; key: string }): Promise<void> {
      const candidateId = candidate(args.candidateId);
      const result = await recordDeadLetter(db, {
        candidateId,
        kind: "apply.stale_sweep",
        subject: `candidate:${candidateId}`,
        reasonCode: "sweep_failed",
        attempts: SWEEP_ATTEMPTS,
        idempotencyKey: args.key,
      });
      // A malformed letter is a bug in this code, not a passing fault: don't retry it.
      if (!result.ok) {
        throw ApplicationFailure.nonRetryable(
          `invalid dead letter: ${result.error.field}`,
          "InvalidInput",
        );
      }
    },
  };
}

export type SweepActivities = ReturnType<typeof createSweepActivities>;
