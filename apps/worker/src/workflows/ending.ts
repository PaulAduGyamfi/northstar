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

// The not_approved reasons a dead letter may name: the Gate's refusal kinds (packages/db
// approval-write.ts), plus the activity's own two for a package it couldn't load (NS-242). A
// reason outside this list becomes `not_approved_unknown`, so free text can never reach a dead
// letter, even reduced to [a-z0-9_].
const NOT_APPROVED_REASONS: ReadonlySet<string> = new Set([
  "AlreadyClosed",
  "AlreadyDecided",
  "AlreadyUndone",
  "ContentChanged",
  "ContentUnchanged",
  "IdempotencyKeyReused",
  "InvalidRequest",
  "NotApproved",
  "NoPackage",
  "NotFound",
  "PackageMismatch",
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
      return code(
        "not_approved",
        NOT_APPROVED_REASONS.has(ending.reason) ? ending.reason : "unknown",
      );
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
// behind a letter already resolved. Known duplicate: a Temporal reset starts a new run id, so a
// reset run whose ending was already recorded files a second letter. It is visible, never hidden,
// only repeated; Paul resolves both (NS-242 noted it, nothing handles it).
export const endingKey = (applicationId: string, runId: string): string =>
  `application:${applicationId}:submit:${runId}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

// Exactly the keys a submission's input may have (NS-242): ids and a hash, never the package or
// any of its fields, which Temporal would keep in plain text in its history.
export const INPUT_KEYS = ["applicationId", "candidateId", "packageSha256"] as const;

// Why a value holds keys other than `allowed`, or null. The message names the first extra key
// only (a key name, never a value).
export function extraKeyProblem(value: object, allowed: readonly string[]): string | null {
  const extra = Object.keys(value).find((k) => !allowed.includes(k));
  return extra === undefined ? null : `unexpected input field: ${extra.slice(0, 40)}`;
}

// Why a workflow input can't run, or null. Checked before waiting for the Gate, so a bad input
// fails at once instead of after the gateway was called: only the expected keys, both ids uuids
// (a bad candidate id would otherwise surface only as the ending activity's InvalidInput, hiding
// the run's own failure) and the hash in shape. The activity checks the package is the
// application's own when it loads it.
export function inputProblem(input: object): string | null {
  const extra = extraKeyProblem(input, INPUT_KEYS);
  if (extra !== null) return extra;
  const { candidateId, applicationId, packageSha256 } = input as Record<string, unknown>;
  if (typeof candidateId !== "string" || !UUID.test(candidateId)) {
    return "candidateId is not a uuid";
  }
  if (typeof applicationId !== "string" || !UUID.test(applicationId)) {
    return "applicationId is not a uuid";
  }
  if (typeof packageSha256 !== "string" || !SHA256.test(packageSha256)) {
    return "packageSha256 is not a sha-256";
  }
  return null;
}
