import type { SubmissionResult } from "./types.js";

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
      return code("not_approved", ending.reason);
    case "activity_failed":
      return "activity_failed";
  }
}

// One dead letter per application ever: a second run's ending for the same application is the
// same letter (and the same key the gateway's submission uses).
export const endingKey = (applicationId: string): string => `application:${applicationId}:submit`;
