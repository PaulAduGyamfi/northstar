import type { SubmitRefusal } from "@northstar/gateways";

// Plain data passed between the submission workflow and its activity. Type-only imports (erased
// before bundling): workflow code runs in Temporal's deterministic sandbox, and these values
// cross it as JSON.

// Every refusal the workflow can see: the gateway's own kinds, plus the Gate's undo window.
export type RefusalKind = SubmitRefusal["kind"] | "UndoWindowOpen";

// What one call to the Apply Gateway came to. `refused` carries the refusal's kind and, for a
// dated refusal, how long to wait (worked out by the activity, so the workflow reads no clock).
export type SubmitStep =
  | {
      kind: "done";
      outcome: "submitted" | "needs_human";
      submissionId: string;
      // The needs_human reason code, or null when submitted.
      reason: string | null;
      replayed: boolean;
    }
  | { kind: "refused"; refusal: RefusalKind; waitMs: number | null };

// How a submission workflow ended.
export type SubmissionResult =
  | {
      kind: "submitted" | "needs_human";
      submissionId: string;
      reason: string | null;
      replayed: boolean;
    }
  // The gateway refused for good (invalid package, changed file, duplicate requisition...).
  | { kind: "refused"; refusal: RefusalKind }
  // Still held back after MAX_WAITS tries: stop rather than loop forever.
  | { kind: "gave_up"; refusal: RefusalKind }
  // The Gate didn't verify the decision id when the gateway acted.
  | { kind: "not_approved"; reason: string }
  // Paul (or a gateway) withdrew the request before it was approved.
  | { kind: "withdrawn" };

// Error type of the activity failure for a decision the Gate didn't verify. Not retryable: the
// same decision id would be refused again.
export const NOT_APPROVED = "NotApproved";

// The Gate's refusal kind for an approval still inside its undo window: wait, then try again.
export const UNDO_WINDOW_OPEN = "UndoWindowOpen";
