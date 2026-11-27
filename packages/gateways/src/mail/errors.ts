import type { CallDecision, CallOutcome } from "@northstar/domain";

// The draft writer's guard port and errors (NS-237 slice 4), apart from its Gmail requests so the
// package can export them without exporting src/mail/drafts.ts.

// The stored kill switch and breaker, asked at the moment each request goes out.
export type DraftGuard = {
  isOn: (subsystem: string) => Promise<boolean>;
  acquire: (dependency: string) => Promise<CallDecision>;
  report: (dependency: string, outcome: CallOutcome, probeToken: string | null) => Promise<void>;
};

// A request the guard held back: it never went out. Retryable (the caller comes back later).
export class DraftHeldBack extends Error {
  override name = "DraftHeldBack";
  constructor(
    readonly by: "kill_switch" | "breaker" | "guard_error",
    readonly what: string,
    readonly retryAt: Date | null,
  ) {
    super(`held back by ${by}: ${what}`);
  }
}

// An answer from Gmail that isn't a success, or no answer (status 0). The message names the status
// and Google's reason code only, never its text, a token or an id.
export class DraftWriteError extends Error {
  override name = "DraftWriteError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// A request outside the allowlist or an id of the wrong shape: a bug, never retried.
export class DraftRequestError extends Error {
  override name = "DraftRequestError";
}

// Refused before a message is built: a caller's bug, never retried. Names the field only.
export class DraftInputError extends Error {
  override name = "DraftInputError";
}
