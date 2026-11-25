import type { CallGuard, GuardDecision, GuardOutcome } from "../guard.js";

// A CallGuard for tests: switches and breaker decisions set per name, every check and report
// recorded in order. `throwOn` makes a check fail, as Postgres being down would.
export function fakeGuard(
  opts: {
    off?: string[];
    decisions?: Record<string, GuardDecision>;
    throwOn?: "isOn" | "acquire" | "report";
  } = {},
): CallGuard & {
  log: string[];
  reports: { dependency: string; outcome: GuardOutcome; probeToken: string | null }[];
} {
  const log: string[] = [];
  const reports: { dependency: string; outcome: GuardOutcome; probeToken: string | null }[] = [];
  const fail = () => {
    const e = new Error("connection refused to db.internal");
    e.name = "DbDown";
    throw e;
  };
  return {
    log,
    reports,
    async isOn(subsystem) {
      log.push(`isOn ${subsystem}`);
      if (opts.throwOn === "isOn") fail();
      return !(opts.off ?? []).includes(subsystem);
    },
    async acquire(dependency) {
      log.push(`acquire ${dependency}`);
      if (opts.throwOn === "acquire") fail();
      return opts.decisions?.[dependency] ?? { allowed: true, probe: false };
    },
    async report(dependency, outcome, probeToken) {
      log.push(`report ${dependency}`);
      if (opts.throwOn === "report") fail();
      reports.push({ dependency, outcome, probeToken });
    },
  };
}
