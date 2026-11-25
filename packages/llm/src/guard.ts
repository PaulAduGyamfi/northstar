// Kill switches and circuit breakers for calls that leave the process (NS-174, RES-002, RES-008).
// The caller passes the guard in, so this package stays free of the database: the CLIs wire it
// to packages/db's isSubsystemOn, acquireCall and recordCallOutcome, and tests pass fakes.

// The same shapes as packages/domain's CallDecision and CallOutcome, field for field, so
// packages/db's functions fit without this package depending on domain.
export type GuardDecision =
  | { allowed: true; probe: false }
  | { allowed: true; probe: true; probeToken: string }
  | { allowed: false; retryAt: Date; lastError: string | null };

export type GuardOutcome = { ok: true } | { ok: false; error: string };

export type CallGuard = {
  // Is this subsystem's kill switch on (agent:<route>)?
  isOn: (subsystem: string) => Promise<boolean>;
  // May a call to this dependency go out now (anthropic, gmail)?
  acquire: (dependency: string) => Promise<GuardDecision>;
  // How the call went, with the probe's token when it was the probe.
  report: (dependency: string, outcome: GuardOutcome, probeToken: string | null) => Promise<void>;
};

export type HeldBy = "kill_switch" | "breaker" | "guard_error";

// A call the guard held back: it never went out and is never reported to a breaker. Always
// retryable: the work waits (a Temporal activity retries it; the CLIs are safe to rerun).
export class HeldBack extends Error {
  override name = "HeldBack";
  readonly retryable = true;
  constructor(
    readonly by: HeldBy,
    // Which switch or dependency held it back (agent:<route>, anthropic, gmail).
    readonly what: string,
    // When the breaker allows the next try; null for a switch or a guard error.
    readonly retryAt: Date | null = null,
  ) {
    // Names only: no request text, no error message.
    super(`HeldBack by=${by} what=${what}`);
  }
}

// The decision for one guarded call: held back, or allowed with the probe's token (null for an
// ordinary call). `errorName` is set when a check threw, for the span.
export type Admission =
  | { ok: true; probeToken: string | null }
  | { ok: false; held: HeldBack; errorName: string | null };

// Checks the kill switch (when one is named) and then the breaker. A check that throws holds the
// call back: no unguarded call goes out (fail safe).
export async function admit(
  guard: CallGuard,
  checks: { subsystem: string | null; dependency: string },
): Promise<Admission> {
  try {
    if (checks.subsystem !== null && !(await guard.isOn(checks.subsystem))) {
      return { ok: false, held: new HeldBack("kill_switch", checks.subsystem), errorName: null };
    }
    const decision = await guard.acquire(checks.dependency);
    if (!decision.allowed) {
      return {
        ok: false,
        held: new HeldBack("breaker", checks.dependency, decision.retryAt),
        errorName: null,
      };
    }
    return { ok: true, probeToken: decision.probe ? decision.probeToken : null };
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    return { ok: false, held: new HeldBack("guard_error", checks.dependency), errorName: name };
  }
}
