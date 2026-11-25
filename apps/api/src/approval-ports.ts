import { type Db, decideApprovals, listPendingApprovals, undoDecision } from "@northstar/db";
import type { CandidateId } from "@northstar/domain";
import type { ApprovalPorts } from "./approvals.js";

// The approval queue's ports on the Gate's real write paths (NS-139). The candidate is always the
// server's own, never the request's, and the Gate records every decision here as Paul's.
export function dbApprovalPorts(db: Db, candidateId: () => Promise<CandidateId>): ApprovalPorts {
  return {
    list: async (kind) => listPendingApprovals(db, await candidateId(), kind),
    // The server's candidate comes last, so nothing in the input can ever replace it.
    decide: async (input) => decideApprovals(db, { ...input, candidateId: await candidateId() }),
    undo: async (decisionId) => undoDecision(db, { candidateId: await candidateId(), decisionId }),
  };
}
