import { err, ok, type Result } from "./result.js";

// The application state machine from docs/requirements/03-auto-apply.md, in pipeline order.
// packages/db copies this list into a CHECK constraint, so the database refuses anything else.
export const APPLICATION_STATUSES = [
  "discovered",
  "scored",
  "queued",
  "package_ready",
  "awaiting_approval",
  "submitting",
  "needs_human",
  "submitted",
  "confirmed",
  "in_process",
  "offer",
  "rejected",
  "withdrawn",
  "ghosted",
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export type IllegalTransition = {
  kind: "IllegalTransition";
  from: ApplicationStatus;
  to: ApplicationStatus;
};

// Which status may follow which. Requirement 03 gives the main line; the extra moves are the
// ones Paul approved in specs/NS-105/spec.md (open question 2).
const ALLOWED_MOVES: Readonly<Record<ApplicationStatus, readonly ApplicationStatus[]>> = {
  discovered: ["scored", "withdrawn"],
  scored: ["queued", "withdrawn"],
  queued: ["package_ready", "withdrawn"],
  package_ready: ["awaiting_approval", "withdrawn"],
  // Back to queued: the approval was rejected and the package gets re-tailored.
  awaiting_approval: ["submitting", "queued", "withdrawn"],
  // needs_human: a CAPTCHA, login wall or odd page hands the form to Paul (APPLY-006).
  submitting: ["submitted", "needs_human", "withdrawn"],
  // Paul either lets the run resume or finishes the submission himself.
  needs_human: ["submitting", "submitted", "withdrawn"],
  // The confirmation email may never arrive, so the later outcomes are reachable directly.
  submitted: ["confirmed", "in_process", "rejected", "ghosted", "withdrawn"],
  confirmed: ["in_process", "rejected", "ghosted", "withdrawn"],
  in_process: ["offer", "rejected", "ghosted", "withdrawn"],
  offer: ["withdrawn"],
  // A late reply revives a ghosted application.
  ghosted: ["in_process", "rejected"],
  rejected: [],
  withdrawn: [],
};

// Returns the new status if the move is allowed, otherwise an IllegalTransition value.
export function nextStatus(
  from: ApplicationStatus,
  to: ApplicationStatus,
): Result<ApplicationStatus, IllegalTransition> {
  if (ALLOWED_MOVES[from].includes(to)) {
    return ok(to);
  }
  return err({ kind: "IllegalTransition", from, to });
}

// A terminal status has no allowed move out of it.
export function isTerminal(status: ApplicationStatus): boolean {
  return ALLOWED_MOVES[status].length === 0;
}

// Type guard for strings read from outside (database rows, API input).
export function isApplicationStatus(value: string): value is ApplicationStatus {
  return (APPLICATION_STATUSES as readonly string[]).includes(value);
}
