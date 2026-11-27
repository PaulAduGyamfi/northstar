import { type CandidateId, type SystemHealth, systemHealth } from "@northstar/domain";
import { readBreakers } from "./breaker-write.js";
import type { Db } from "./db.js";
import { readKillSwitches } from "./kill-switch-write.js";
import { inSpan } from "./resilience-event.js";
import { listWatches } from "./watch-write.js";
import { readWorkerHeartbeats } from "./worker-health-write.js";

// The health model (RES-013) over stored state: breakers and kill switches (NS-126) and board
// watches (NS-115). Read-only. If Postgres is down this throws, and the caller shows the whole
// system as down: nothing else can be known then.
export async function readSystemHealth(db: Db, candidateId: CandidateId): Promise<SystemHealth> {
  return inSpan("health.read", {}, async (span) => {
    const [breakers, switches, watches, workers] = await Promise.all([
      readBreakers(db, candidateId),
      readKillSwitches(db, candidateId),
      listWatches(db, candidateId),
      readWorkerHeartbeats(db, candidateId),
    ]);
    const health = systemHealth({ breakers, switches, watches, workers });
    // Counts and the overall status only: subsystem names stay out of spans.
    span.setAttributes({
      "northstar.health.overall": health.overall,
      "northstar.health.subsystems": health.subsystems.length,
      "northstar.health.unhealthy": health.subsystems.filter((s) => s.health !== "healthy").length,
    });
    return health;
  });
}
