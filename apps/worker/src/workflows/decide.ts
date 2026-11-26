import { NOT_APPROVED, type RefusalKind, type SubmissionResult, type SubmitStep } from "./types.js";

// Plain code (no Temporal APIs, no clock) that turns one gateway answer into the workflow's next
// move: finish, or wait on a durable timer and call the gateway again.

export type Decision = { kind: "finish"; result: SubmissionResult } | { kind: "wait"; ms: number };

// Refusals that mean "not now": the gateway claimed nothing (or an earlier run holds the claim),
// so calling again later is safe. Every other refusal is final for this package.
export const WAIT_REFUSALS: ReadonlySet<RefusalKind> = new Set<RefusalKind>([
  "InProgress",
  "AtsBusy",
  "Paced",
  "DailyCapReached",
  "HeldBack",
  // Paul approved, but the 2-minute undo window is still open (ADR-0017).
  "UndoWindowOpen",
]);

// First wait when the gateway gave no time: an earlier run may still be in the browser
// (InProgress), the ATS lane is busy, or a kill switch is off. Each repeat doubles it.
const FIRST_WAIT_MS: Readonly<Partial<Record<RefusalKind, number>>> = {
  InProgress: 5 * 60_000,
  AtsBusy: 2 * 60_000,
  HeldBack: 60_000,
  // The undo window's length: the first retry lands just after it closes.
  UndoWindowOpen: 2 * 60_000,
};
const FALLBACK_FIRST_WAIT_MS = 60_000;
// Undated waits stop doubling here, like the breaker's pause (ADR-0007).
const MAX_BACKOFF_MS = 15 * 60_000;
// A dated wait (Paced, DailyCapReached) is at least a second and at most a day.
const MIN_WAIT_MS = 1_000;
const MAX_WAIT_MS = 24 * 60 * 60_000;
// After this many waits the workflow stops as gave_up, so a switch left off can't loop forever.
export const MAX_WAITS = 20;

export function decide(step: SubmitStep, waitsSoFar: number): Decision {
  if (step.kind === "done") {
    const { outcome, submissionId, reason, replayed } = step;
    return { kind: "finish", result: { kind: outcome, submissionId, reason, replayed } };
  }
  if (!WAIT_REFUSALS.has(step.refusal)) {
    return { kind: "finish", result: { kind: "refused", refusal: step.refusal } };
  }
  if (waitsSoFar >= MAX_WAITS) {
    return { kind: "finish", result: { kind: "gave_up", refusal: step.refusal } };
  }
  if (step.waitMs !== null) {
    return { kind: "wait", ms: Math.min(Math.max(step.waitMs, MIN_WAIT_MS), MAX_WAIT_MS) };
  }
  const first = FIRST_WAIT_MS[step.refusal] ?? FALLBACK_FIRST_WAIT_MS;
  // 2 ** waitsSoFar grows fast; the cap keeps it at 15 minutes.
  return { kind: "wait", ms: Math.min(first * 2 ** waitsSoFar, MAX_BACKOFF_MS) };
}

// The not_approved reason for an activity failure the Gate caused, or null for any other error.
// Plain code so it can be tested without a Temporal server; the workflow passes in the failure's
// cause (ActivityFailure.cause).
export function notApprovedReason(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null) return null;
  const { type, message } = cause as { type?: unknown; message?: unknown };
  return type === NOT_APPROVED && typeof message === "string" ? message : null;
}
