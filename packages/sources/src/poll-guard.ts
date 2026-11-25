import { acquireCall, type Db, isSubsystemOn, recordCallOutcome } from "@northstar/db";
import type { CandidateId } from "@northstar/domain";
import type { PollGuard } from "./poll.js";

// Board polling's kill switches and breakers on the stored ones (NS-126): `source:<ats>` for
// both. Every check reads Postgres, so a switch flipped in the app holds the next board back.
export function dbPollGuard(db: Db, candidateId: CandidateId): PollGuard {
  return {
    isOn: (subsystem) => isSubsystemOn(db, candidateId, subsystem),
    acquire: (dependency) => acquireCall(db, { candidateId, dependency }),
    report: async (dependency, outcome, probeToken) => {
      await recordCallOutcome(db, { candidateId, dependency, outcome, probeToken });
    },
  };
}
