import type { CallDecision, CallOutcome } from "@northstar/domain";

// The Calendar writer's guard port and errors (NS-241 slice 3, ADR-0031), apart from its requests
// so the package can export them without exporting src/calendar/requests.ts.

// The stored kill switch and breaker, asked at the moment each request goes out.
export type CalendarWriteGuard = {
  isOn: (subsystem: string) => Promise<boolean>;
  acquire: (dependency: string) => Promise<CallDecision>;
  report: (dependency: string, outcome: CallOutcome, probeToken: string | null) => Promise<void>;
};

// A request the guard held back: it never went out. Retryable (the caller comes back later).
export class CalendarWriteHeldBack extends Error {
  override name = "CalendarWriteHeldBack";
  constructor(
    readonly by: "kill_switch" | "breaker" | "guard_error",
    readonly what: string,
    readonly retryAt: Date | null,
  ) {
    super(`held back by ${by}: ${what}`);
  }
}

// An answer from Google that isn't a success, or no answer (status 0). The message names the
// status and Google's reason code only, never its text, a token or an id.
export class CalendarWriteError extends Error {
  override name = "CalendarWriteError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// A request outside the allowlist, or an input of the wrong shape: a bug, never retried. Names
// the field only.
export class CalendarWriteRequestError extends Error {
  override name = "CalendarWriteRequestError";
}
