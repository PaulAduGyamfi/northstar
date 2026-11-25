// Circuit breakers per dependency (RES-002, ADR-0007 item 3), as a pure state machine: time is
// passed in, the stored state lives in packages/db. Plain code decides whether a call may go out.

// Failures in a row that open a closed breaker.
export const FAILURE_THRESHOLD = 5;
// The first pause; each reopen without a success doubles it, up to the cap.
export const BASE_COOLDOWN_MS = 60_000;
export const MAX_COOLDOWN_MS = 15 * 60_000;
// How long one probe may run before another caller may probe instead (a crashed caller never
// reports).
export const PROBE_TIMEOUT_MS = 2 * 60_000;

export type BreakerStatus = "closed" | "open" | "half_open";

export type BreakerState = {
  status: BreakerStatus;
  consecutiveFailures: number;
  // Times it opened since the last success: sets the pause.
  opens: number;
  // open: when a probe may go out; half_open: when the probe counts as lost. Null when closed.
  retryAt: Date | null;
  // The last failure's error name (TimeoutError, RateLimited), never a message.
  lastError: string | null;
};

export const CLOSED: BreakerState = {
  status: "closed",
  consecutiveFailures: 0,
  opens: 0,
  retryAt: null,
  lastError: null,
};

export type CallDecision =
  | { allowed: true; probe: boolean }
  | { allowed: false; retryAt: Date; lastError: string | null };

export type CallOutcome = { ok: true } | { ok: false; error: string };

const pauseFor = (opens: number): number =>
  Math.min(BASE_COOLDOWN_MS * 2 ** Math.max(0, opens - 1), MAX_COOLDOWN_MS);

const later = (now: Date, ms: number) => new Date(now.getTime() + ms);

// Whether a call may go out now, and the state after asking. Past retryAt, the first caller is
// the probe and the breaker turns half_open, so the callers after it are refused.
export function onAcquire(
  state: BreakerState,
  now: Date,
): { decision: CallDecision; state: BreakerState } {
  if (state.status === "closed") return { decision: { allowed: true, probe: false }, state };
  const retryAt = state.retryAt ?? now;
  if (now.getTime() < retryAt.getTime()) {
    return { decision: { allowed: false, retryAt, lastError: state.lastError }, state };
  }
  return {
    decision: { allowed: true, probe: true },
    state: { ...state, status: "half_open", retryAt: later(now, PROBE_TIMEOUT_MS) },
  };
}

// The state after a call reports back. A success closes and resets; a failure counts, opens the
// breaker at the threshold, and a failed probe reopens it with a longer pause. While open, a
// late report from a call that started before it opened changes nothing.
export function onOutcome(state: BreakerState, outcome: CallOutcome, now: Date): BreakerState {
  if (state.status === "open") return state;
  if (outcome.ok) return CLOSED;
  const consecutiveFailures = state.consecutiveFailures + 1;
  if (state.status === "half_open" || consecutiveFailures >= FAILURE_THRESHOLD) {
    const opens = state.opens + 1;
    return {
      status: "open",
      consecutiveFailures,
      opens,
      retryAt: later(now, pauseFor(opens)),
      lastError: outcome.error,
    };
  }
  return { ...state, consecutiveFailures, lastError: outcome.error };
}
