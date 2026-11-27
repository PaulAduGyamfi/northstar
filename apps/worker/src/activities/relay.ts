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

export type RelayCounts = { signalled: number; skipped: number; failed: number };

// A pass in which some rounds failed (a Temporal call that errored): thrown after every other
// round was tried, so one stuck run never holds back the rest.
export class RelayRoundsFailed extends Error {
  constructor(readonly counts: RelayCounts) {
    super(`${counts.failed} of the pass's rounds failed`);
    this.name = "RelayRoundsFailed";
  }
}

// One pass over a candidate's settled outcomes. Counts only: ids stay out of Temporal's history.
export async function relayPass(
  read: ReadSignals,
  port: TemporalPort,
  candidateId: CandidateId,
): Promise<RelayCounts> {
  const counts: RelayCounts = { signalled: 0, skipped: 0, failed: 0 };
  for (const signal of await read(candidateId)) {
    try {
      counts[await relayRound(port, signal)]++;
    } catch (error) {
      // A bug, not a passing fault: stop at once, without retry.
      if (error instanceof ApplicationFailure && error.nonRetryable) throw error;
      counts.failed++;
    }
  }
  if (counts.failed > 0) throw new RelayRoundsFailed(counts);
  return counts;
}

async function relayRound(
  port: TemporalPort,
  signal: PackageSignal,
): Promise<"signalled" | "skipped"> {
  const round = { applicationId: signal.applicationId, packageSha256: signal.packageSha256 };
  // Not started, already ended, or already decided: nothing to tell it.
  if (!(await roundWaiting(port, round))) return "skipped";
  const sent =
    signal.kind === "approval"
      ? await signalApproval(port, round, signal.decisionId)
      : await signalWithdrawn(port, round);
  if (sent.ok) return "signalled";
  // The run ended between the check and the signal: nothing left to tell it.
  if (sent.error.kind === "NotRunning") return "skipped";
  // Ids from the database that aren't ids are a bug, not a passing fault.
  throw ApplicationFailure.nonRetryable(sent.error.problem, "InvalidInput");
}

// `port` is called per pass: the worker binds it to its own client in the activity's context.
export function createRelayActivities(read: ReadSignals, port: () => TemporalPort, db: Db) {
  return {
    // A failure is thrown for the retry policy: a repeated pass reads and checks again.
    async relayPackageDecisions(args: { candidateId: string }): Promise<RelayCounts> {
      return relayPass(read, port(), candidate(args.candidateId));
    },
    // Records a pass that failed all its attempts. `key` names the workflow run, so a retried call,
    // or every failing pass of one run (100 passes), stores one letter, not one a minute.
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
