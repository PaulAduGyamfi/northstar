import { SUBMIT_ATTEMPTS, type SubmissionResult } from "./types.js";

// Plain code (no Temporal APIs) that decides whether a submission workflow's ending needs a dead
// letter (NS-226, RES-007), and its reason code. An ending nobody else shows would otherwise live
// only in Temporal's history while the application sits waiting with a live approval.

// How a run ended: a result, or the activity failing all its attempts.
export type SubmissionEnding = SubmissionResult | { kind: "activity_failed" };

// The dead letter's reason-code limit (REASON_CODE_PATTERN in packages/db: up to 64 characters).
const MAX_REASON = 64;

// "DuplicateRequisition" → "duplicate_requisition". Anything outside [a-z0-9_] is dropped, so a
// reason code can never carry a message, a URL or punctuation.
export function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

const code = (prefix: string, name: string) =>
  `${prefix}_${snakeCase(name) || "unknown"}`.slice(0, MAX_REASON).replace(/_$/, "");

// The Gate's refusal kinds (packages/db approval-write.ts). A not_approved reason outside this
// list becomes `not_approved_unknown`, so free text can never reach a dead letter, even reduced to
// [a-z0-9_].
const GATE_REASONS: ReadonlySet<string> = new Set([
  "AlreadyClosed",
  "AlreadyDecided",
  "AlreadyUndone",
  "ContentChanged",
  "ContentUnchanged",
  "IdempotencyKeyReused",
  "InvalidRequest",
  "NotApproved",
  "NotFound",
  "ReasonRequired",
  "Rejected",
  "SubjectAlreadyRequested",
  "SubjectMismatch",
  "SubjectReopened",
  "UndoWindowClosed",
  "UndoWindowOpen",
  "Undone",
  "Withdrawn",
]);

// The reason code for a dead letter, or null when the ending is already visible elsewhere:
// - submitted / needs_human: the gateway's proof and its handoff;
// - withdrawn: the Gate's own `approval.withdrawn` feed line.
export function endingReason(ending: SubmissionEnding): string | null {
  switch (ending.kind) {
    case "submitted":
    case "needs_human":
    case "withdrawn":
      return null;
    case "refused":
      return code("refused", ending.refusal);
    case "gave_up":
      return code("gave_up", ending.refusal);
    case "not_approved":
      return code("not_approved", GATE_REASONS.has(ending.reason) ? ending.reason : "unknown");
    case "activity_failed":
      return "activity_failed";
  }
}

export type EndingLetter = { reasonCode: string; attempts: number };

// What a run's ending records: its reason code and attempt count, or null when it is already
// visible. `attempts` is the gateway calls made; a letter needs at least one.
export function endingLetter(ending: SubmissionEnding, attempts: number): EndingLetter | null {
  const reasonCode = endingReason(ending);
  return reasonCode === null ? null : { reasonCode, attempts: Math.max(attempts, 1) };
}

// Gateway calls made when the activity finally failed: the calls of earlier loop passes, plus all
// of this call's attempts when Temporal stopped on the retry limit, or one when it failed for good
// at once (a non-retryable error). `retryState` is the ActivityFailure's.
export function failedAttempts(earlierCalls: number, retryState: string | undefined): number {
  return earlierCalls + (retryState === "MAXIMUM_ATTEMPTS_REACHED" ? SUBMIT_ATTEMPTS : 1);
}

// One dead letter per workflow run: an activity retry within the run stores one letter, and a
// later run for the same application (after Paul's Retry) gets its own, so its failure can't hide
// behind a letter already resolved.
export const endingKey = (applicationId: string, runId: string): string =>
  `application:${applicationId}:submit:${runId}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Why a workflow input can't run, or null. Checked before waiting for the Gate, so a bad id fails
// at once instead of after the gateway was called: the application id must be a uuid and be the
// package's own, so a letter can never be filed against another application.
export function inputProblem(input: { applicationId: string; package: unknown }): string | null {
  if (!UUID.test(input.applicationId)) return "applicationId is not a uuid";
  const pkg = input.package;
  const own =
    typeof pkg === "object" && pkg !== null
      ? (pkg as { applicationId?: unknown }).applicationId
      : undefined;
  if (own !== input.applicationId) return "applicationId is not the package's";
  return null;
}
