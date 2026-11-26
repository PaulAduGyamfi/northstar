import {
  type Db,
  type InvalidVaultInput,
  revealSealedSecret,
  type SealedVersion,
  type SecretNotFound,
  type VaultLocked,
} from "@northstar/db";
import type { CandidateId, Result } from "@northstar/domain";
import type { MasterKey } from "./key.js";
import { openSecret, type VaultKeyMismatch, type VaultTampered } from "./open.js";
import type { VaultSecret } from "./secret.js";

// Revealing one of Paul's vault passwords to him (NS-182, CRD-002, ADR-0024). The one opening
// this package exports. The database files, approves and uses a one-time `vault_reveal` for this
// tenant in one transaction (revealSealedSecret), so no decision id passes through any caller.
// Its only caller is the API's reveal route (apps/api/src/vault-reveal.ts, NS-230), after a
// WebAuthn assertion made within 60 seconds; the boundary test fails if anything else names it. The decrypt stays in open.ts.

export type RevealPorts = {
  revealSealedSecret: (
    input: Parameters<typeof revealSealedSecret>[1],
  ) => Promise<Result<SealedVersion, InvalidVaultInput | VaultLocked | SecretNotFound>>;
};

export type RevealError =
  | InvalidVaultInput
  | VaultLocked
  | SecretNotFound
  | VaultKeyMismatch
  | VaultTampered;

export async function revealTenantPassword(
  ports: RevealPorts,
  masterKey: MasterKey,
  input: { candidateId: CandidateId; tenantKey: string },
): Promise<Result<VaultSecret, RevealError>> {
  const sealed = await ports.revealSealedSecret(input);
  if (!sealed.ok) return sealed;
  return openSecret(masterKey, input.candidateId, sealed.value);
}

// The reveal's port on the real write path.
export function dbRevealPorts(db: Db): RevealPorts {
  return { revealSealedSecret: (input) => revealSealedSecret(db, input) };
}
