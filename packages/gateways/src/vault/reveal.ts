import { REVEAL_ACTOR, REVEAL_PURPOSE } from "@northstar/db";
import type { CandidateId, Result } from "@northstar/domain";
import type { MasterKey } from "./key.js";
import { type OpenError, type OpenPorts, useTenantPassword } from "./open.js";
import type { VaultSecret } from "./secret.js";

// Revealing one of Paul's vault passwords to him (NS-182, CRD-002, ADR-0024). The one opening
// this package exports, and it can do only this: the actor is always `user` and the purpose
// always `reveal_to_user`, so the database lets it open only under Paul's `vault_reveal`
// approval for this tenant, once. The caller (the API, after a fresh passkey check) passes the
// decision id; the decrypt itself stays in open.ts, which nothing outside this package imports.
export async function revealTenantPassword(
  ports: OpenPorts,
  masterKey: MasterKey,
  input: { candidateId: CandidateId; tenantKey: string; decisionId: string },
): Promise<Result<VaultSecret, OpenError>> {
  return useTenantPassword(ports, masterKey, {
    candidateId: input.candidateId,
    tenantKey: input.tenantKey,
    actor: REVEAL_ACTOR,
    purpose: REVEAL_PURPOSE,
    decisionId: input.decisionId,
  });
}
