import {
  type ApplyLimits,
  acquireCall,
  claimSubmission,
  type Db,
  DEFAULT_APPLY_LIMITS,
  isSubsystemOn,
  listStaleClaims,
  openSealedSecret,
  recordCallOutcome,
  recordNeedsHuman,
  recordSubmitted,
  storeSealedSecret,
  transitionApplication,
  verifyApproval,
} from "@northstar/db";
import type { CallDecision, CallOutcome, CandidateId } from "@northstar/domain";
import type { OpenPorts } from "../vault/open.js";
import type { StorePorts } from "../vault/store.js";
import type { FormDriver } from "./driver.js";
import type { SweepPorts } from "./stale.js";

// Everything the Apply Gateway touches, so tests can pass fakes and production passes the
// database (dbPorts). The database functions are the real write paths: the Gate's
// verifyApproval, the submission ledger and transitionApplication.
export type ApplyPorts = {
  verifyApproval: (
    input: Parameters<typeof verifyApproval>[1],
  ) => ReturnType<typeof verifyApproval>;
  claimSubmission: (
    input: Parameters<typeof claimSubmission>[1],
  ) => ReturnType<typeof claimSubmission>;
  recordSubmitted: (
    candidateId: CandidateId,
    submissionId: string,
    proof: Parameters<typeof recordSubmitted>[3],
  ) => ReturnType<typeof recordSubmitted>;
  recordNeedsHuman: (
    candidateId: CandidateId,
    submissionId: string,
    reason: Parameters<typeof recordNeedsHuman>[3],
    // The package's apply URL: a challenge opens a handoff to it for Paul (NS-121).
    applyUrl?: string,
  ) => ReturnType<typeof recordNeedsHuman>;
  transitionApplication: (
    input: Parameters<typeof transitionApplication>[1],
  ) => ReturnType<typeof transitionApplication>;
  // The bytes of an approved file by its SHA-256, or null if it is gone.
  readFile: (sha256: string) => Promise<Uint8Array | null>;
  // A fresh browser session for one submission.
  openDriver: () => FormDriver;
  // The stored kill switches and breakers (NS-206, RES-002/008), asked at the moment it acts.
  isSubsystemOn: (candidateId: CandidateId, subsystem: string) => Promise<boolean>;
  acquireCall: (candidateId: CandidateId, dependency: string) => Promise<CallDecision>;
  recordCallOutcome: (
    candidateId: CandidateId,
    dependency: string,
    outcome: CallOutcome,
    // The token acquireCall gave the probe; null for any other call.
    probeToken: string | null,
  ) => Promise<void>;
};

// `limits` come from loadApplyLimits at the entry point (NS-143), never from a caller per call.
export function dbPorts(
  db: Db,
  deps: Pick<ApplyPorts, "readFile" | "openDriver">,
  limits: ApplyLimits = DEFAULT_APPLY_LIMITS,
): ApplyPorts {
  return {
    verifyApproval: (input) => verifyApproval(db, input),
    claimSubmission: (input) => claimSubmission(db, input, limits),
    recordSubmitted: (c, s, p) => recordSubmitted(db, c, s, p),
    recordNeedsHuman: (c, s, r, url) => recordNeedsHuman(db, c, s, r, url),
    transitionApplication: (input) => transitionApplication(db, input),
    isSubsystemOn: (c, subsystem) => isSubsystemOn(db, c, subsystem),
    acquireCall: (c, dependency) => acquireCall(db, { candidateId: c, dependency }),
    recordCallOutcome: async (c, dependency, outcome, probeToken) => {
      await recordCallOutcome(db, { candidateId: c, dependency, outcome, probeToken });
    },
    ...deps,
  };
}

// The sweep's ports on the real write paths: the ledger's stale-claim read, its needs_human
// write and transitionApplication.
export function dbSweepPorts(db: Db): SweepPorts {
  return {
    listStaleClaims: (candidateId) => listStaleClaims(db, candidateId),
    recordNeedsHuman: (c, s, r) => recordNeedsHuman(db, c, s, r),
    transitionApplication: (input) => transitionApplication(db, input),
  };
}

// The vault's ports on the real write paths (NS-122): storing sealed rows, and handing one out
// with its access recorded. Decryption itself stays in src/vault/open.ts.
export function dbVaultPorts(db: Db): StorePorts & OpenPorts {
  return {
    storeSealedSecret: (input) => storeSealedSecret(db, input),
    openSealedSecret: (input) => openSealedSecret(db, input),
  };
}
