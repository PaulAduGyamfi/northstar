import { type Db, type PackageSignal, readPackageSignals, recordDeadLetter } from "@northstar/db";
import { CandidateId } from "@northstar/domain";
import { ApplicationFailure } from "@temporalio/common";
import { roundWaiting, signalApproval, signalWithdrawn, type TemporalPort } from "../client.js";
import { RELAY_ATTEMPTS } from "../workflows/types.js";

// The package decision relay's activities (NS-213 slice 2, #195 item 2): one pass that tells each
// waiting submission workflow the Gate's settled outcome for its package round, and the dead
// letter for a pass that kept failing (RES-007, ADR-0007: never a silent drop).
//
// Only a run that still waits is signalled, so repeated passes add nothing to a run's history. A
// signal is safe to repeat anyway: the run keeps the first decision it gets.

// readPackageSignals bound to the database.
type ReadSignals = (candidateId: CandidateId) => Promise<PackageSignal[]>;

// A candidate id crosses Temporal as JSON: checked again here. Bad input never improves.
function candidate(raw: string): CandidateId {
  const parsed = CandidateId.safeParse(raw);
  if (!parsed.success)
    throw ApplicationFailure.nonRetryable("candidateId is not a uuid", "InvalidInput");
  return parsed.data;
}

export type RelayCounts = { signalled: number; skipped: number };

// One pass over a candidate's settled outcomes. Counts only: ids stay out of Temporal's history.
export async function relayPass(
  read: ReadSignals,
  port: TemporalPort,
  candidateId: CandidateId,
): Promise<RelayCounts> {
  let signalled = 0;
  let skipped = 0;
  for (const signal of await read(candidateId)) {
    const round = { applicationId: signal.applicationId, packageSha256: signal.packageSha256 };
    // Not started, already ended, or already decided: nothing to tell it.
    if (!(await roundWaiting(port, round))) {
      skipped++;
      continue;
    }
    const sent =
      signal.kind === "approval"
        ? await signalApproval(port, round, signal.decisionId)
        : await signalWithdrawn(port, round);
    if (sent.ok) {
      signalled++;
      continue;
    }
    // The run ended between the check and the signal: nothing left to tell it.
    if (sent.error.kind === "NotRunning") {
      skipped++;
      continue;
    }
    // Ids from the database that aren't ids are a bug, not a passing fault.
    throw ApplicationFailure.nonRetryable(sent.error.problem, "InvalidInput");
  }
  return { signalled, skipped };
}

// `port` is called per pass: the worker binds it to its own client in the activity's context.
export function createRelayActivities(read: ReadSignals, port: () => TemporalPort, db: Db) {
  return {
    // A failure is thrown for the retry policy: a repeated pass reads and checks again.
    async relayPackageDecisions(args: { candidateId: string }): Promise<RelayCounts> {
      return relayPass(read, port(), candidate(args.candidateId));
    },
    // Records a pass that failed all its attempts. `key` names the workflow run and pass, so a
    // retried call stores one letter.
    async recordRelayFailure(args: { candidateId: string; key: string }): Promise<void> {
      const candidateId = candidate(args.candidateId);
      const result = await recordDeadLetter(db, {
        candidateId,
        kind: "apply.signal_relay",
        subject: `candidate:${candidateId}`,
        reasonCode: "relay_failed",
        attempts: RELAY_ATTEMPTS,
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

export type RelayActivities = ReturnType<typeof createRelayActivities>;

// For the reader's default binding.
export const dbReadSignals =
  (db: Db): ReadSignals =>
  (candidateId) =>
    readPackageSignals(db, candidateId);
