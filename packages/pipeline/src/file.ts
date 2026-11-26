import {
  type BankClaim,
  type Db,
  type RequestError,
  type RequestResult,
  requestPackageApproval,
} from "@northstar/db";
import type { CandidateId, Result } from "@northstar/domain";
import { type Assembled, bankSource } from "./assemble.js";

// Files an assembled package with the Approval Gate (NS-161, ADR-0002, ADR-0017): it waits in
// Paul's queue, or a policy he set approves it. It is never submitted from here; only the Apply
// Gateway submits, after verifying the decision.
//
// Since NS-213 the Gate derives the policy facts from stored records itself; this passes only the
// package and its bank claims, which the Gate verifies against Paul's banked text. Filing the same
// package again replays the first request.
export function filePackage(
  db: Db,
  candidateId: CandidateId,
  assembled: Assembled,
): Promise<Result<RequestResult, RequestError>> {
  return requestPackageApproval(db, {
    candidateId,
    package: assembled.package,
    claims: bankClaims(assembled),
    actor: "system",
    idempotencyKey: `package:${assembled.package.packageId}`,
  });
}

// The bank answers that count as reuse by assemblePackage's own rule (a model's pick or a low
// match never does); every other field is new to the Gate anyway.
export function bankClaims(assembled: Assembled): BankClaim[] {
  const claims: BankClaim[] = [];
  for (const s of assembled.sources) {
    const source = bankSource(s);
    if (s.from !== "bank" || source === "new") continue;
    claims.push({
      fieldName: s.fieldName,
      answerId: s.answerId,
      version: s.version,
      variant: s.variant,
      source,
    });
  }
  return claims;
}
