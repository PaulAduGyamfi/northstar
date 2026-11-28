// Plain code for the stale-claim sweep (NS-220): checks the workflow's input once, at start, and
// names a failed pass's dead letter. No Temporal APIs, so it is tested without a server.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const DEFAULT_SWEEP_INTERVAL_MINUTES = 5;
// A day at most: a longer gap would leave dead claims holding ATS lanes for too long.
const MAX_SWEEP_INTERVAL_MINUTES = 24 * 60;

export type SweepPlan =
  | { ok: true; candidateIds: string[]; minutes: number }
  | { ok: false; problem: string };

// The candidates and the interval, or why the input can't run. A bad id or interval stops the
// workflow before its first pass, rather than one bad id stopping every candidate mid-run, or a
// zero interval sweeping the database in a tight loop.
// The package decision relay (NS-213 slice 2) checks its input the same way, with its own default.
export function planSweep(
  input: { candidateIds: string[]; intervalMinutes?: number },
  defaultMinutes: number = DEFAULT_SWEEP_INTERVAL_MINUTES,
): SweepPlan {
  if (input.candidateIds.length === 0) return { ok: false, problem: "no candidates" };
  const bad = input.candidateIds.findIndex((id) => !UUID.test(id));
  if (bad >= 0) return { ok: false, problem: `candidate ${bad} is not a uuid` };
  const minutes = input.intervalMinutes ?? defaultMinutes;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_SWEEP_INTERVAL_MINUTES) {
    return { ok: false, problem: "intervalMinutes must be a whole number from 1 to 1440" };
  }
  return { ok: true, candidateIds: [...new Set(input.candidateIds)], minutes };
}

// The dead letter's key for one failed pass: the workflow run and the pass number name it, so a
// retried write stores one letter, and no clock is read inside the workflow.
export const failureKey = (runId: string, pass: number): string => `stale_sweep:${runId}:${pass}`;

// The relay's dead letter (NS-213 slice 2): one per workflow run, so a failure that lasts writes
// one letter per run of 100 passes, not one a minute.
export const relayFailureKey = (runId: string): string => `signal_relay:${runId}`;

// The handoff notifier's dead-letter key for a failing pass (NS-193 slice 3): one per run.
export const notifyFailureKey = (runId: string): string => `push_notify:${runId}`;
