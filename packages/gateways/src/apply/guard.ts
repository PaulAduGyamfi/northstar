import { type ApplyAts, type CandidateId, err, ok, type Result } from "@northstar/domain";
import type { Span } from "@opentelemetry/api";
import type { ApplyPorts } from "./ports.js";
import type { HeldBack } from "./submit.js";

// The Apply Gateway's kill switches and breaker (NS-206, RES-002, RES-008, ADR-0007). The
// switch and breaker names follow packages/db's patterns: `auto_apply` and `adapter:<ats>`
// switches, one `ats:<ats>` breaker per ATS.

export const AUTO_APPLY_SWITCH = "auto_apply";
export const adapterSwitch = (ats: ApplyAts) => `adapter:${ats}`;
export const atsDependency = (ats: ApplyAts) => `ats:${ats}`;

type GuardPorts = Pick<ApplyPorts, "isSubsystemOn" | "acquireCall">;

// Asks auto_apply, then the adapter's switch, then the ATS's breaker, at the moment the gateway
// acts. Allowed: the probe's token (null for an ordinary call), which goes back with the report.
// A check that throws holds the submission back (fail safe: no unguarded submission).
export async function admit(
  ports: GuardPorts,
  candidateId: CandidateId,
  ats: ApplyAts,
  span: Span,
): Promise<Result<string | null, HeldBack>> {
  const dependency = atsDependency(ats);
  const held = (by: HeldBack["by"], what: string, retryAt: Date | null = null) => {
    span.setAttribute("northstar.apply.held_by", by);
    return err({ kind: "HeldBack" as const, by, what, retryAt });
  };
  try {
    for (const subsystem of [AUTO_APPLY_SWITCH, adapterSwitch(ats)]) {
      if (!(await ports.isSubsystemOn(candidateId, subsystem))) {
        return held("kill_switch", subsystem);
      }
    }
    const decision = await ports.acquireCall(candidateId, dependency);
    if (!decision.allowed) return held("breaker", dependency, decision.retryAt);
    return ok(decision.probe ? decision.probeToken : null);
  } catch (error) {
    // The error's name only: a database error's message can quote a row or a host.
    span.setAttribute("northstar.apply.guard_error", error instanceof Error ? error.name : "Error");
    return held("guard_error", dependency);
  }
}
