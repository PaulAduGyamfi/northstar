import { type Db, type RequestError, type RequestResult, requestApproval } from "@northstar/db";
import { type CandidateId, packageSubject, type Result } from "@northstar/domain";
import type { Assembled } from "./assemble.js";

// Files an assembled package with the Approval Gate (NS-161, ADR-0002, ADR-0017): it waits in
// Paul's queue, or a policy he set approves it. It is never submitted from here; only the Apply
// Gateway submits, after verifying the decision.
//
// Facts go to the Gate from plain code only (NFR-SEC-004): the caller is a workflow step, never an
// agent that read untrusted text. Filing the same package again replays the first request.
export function filePackage(
  db: Db,
  candidateId: CandidateId,
  assembled: Assembled,
): Promise<Result<RequestResult, RequestError>> {
  return requestApproval(db, {
    candidateId,
    kind: "application_package",
    subject: packageSubject(assembled.package),
    contentSha256: assembled.sha256,
    facts: assembled.facts,
    actor: "system",
    idempotencyKey: `package:${assembled.package.packageId}`,
  });
}
