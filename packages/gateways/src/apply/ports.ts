import {
  claimSubmission,
  type Db,
  recordNeedsHuman,
  recordSubmitted,
  transitionApplication,
  verifyApproval,
} from "@northstar/db";
import type { CandidateId } from "@northstar/domain";
import type { FormDriver } from "./driver.js";

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
  ) => ReturnType<typeof recordNeedsHuman>;
  transitionApplication: (
    input: Parameters<typeof transitionApplication>[1],
  ) => ReturnType<typeof transitionApplication>;
  // The bytes of an approved file by its SHA-256, or null if it is gone.
  readFile: (sha256: string) => Promise<Uint8Array | null>;
  // A fresh browser session for one submission.
  openDriver: () => FormDriver;
};

export function dbPorts(db: Db, deps: Pick<ApplyPorts, "readFile" | "openDriver">): ApplyPorts {
  return {
    verifyApproval: (input) => verifyApproval(db, input),
    claimSubmission: (input) => claimSubmission(db, input),
    recordSubmitted: (c, s, p) => recordSubmitted(db, c, s, p),
    recordNeedsHuman: (c, s, r) => recordNeedsHuman(db, c, s, r),
    transitionApplication: (input) => transitionApplication(db, input),
    ...deps,
  };
}
