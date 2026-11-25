import { randomInt } from "node:crypto";
import type { InvalidVaultInput, SealedSecret } from "@northstar/db";
import type { CandidateId, Result } from "@northstar/domain";
import type { MasterKey } from "./key.js";
import { sealSecret } from "./seal.js";
import { VaultSecret } from "./secret.js";

// Creating and rotating tenant passwords (NS-122, ADR-0010 item 1). Northstar generates a unique
// strong password per tenant, seals it here and stores only the envelope.

const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
// Symbols ATS password rules accept; no quotes or backslashes, which some forms mangle.
const SYMBOLS = "!#$%&*+-=?@^_";
const ALL = LOWER + UPPER + DIGITS + SYMBOLS;
export const TENANT_PASSWORD_LENGTH = 24;

const pick = (alphabet: string): string => alphabet.charAt(randomInt(alphabet.length));

// 24 characters from a cryptographic RNG, with at least one of each class (ATS rules usually ask
// for all four), shuffled so the guaranteed ones aren't always first.
export function generateTenantPassword(): VaultSecret {
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < TENANT_PASSWORD_LENGTH) chars.push(pick(ALL));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j] ?? "", chars[i] ?? ""];
  }
  return new VaultSecret(chars.join(""));
}

export type StorePorts = {
  storeSealedSecret: (input: {
    candidateId: CandidateId;
    tenantKey: string;
    actor: string;
    sealed: SealedSecret;
  }) => Promise<Result<{ secretId: string; version: number }, InvalidVaultInput>>;
};

// Seals a tenant's password and stores it as the tenant's next version (create or rotate).
export async function storeTenantPassword(
  ports: StorePorts,
  masterKey: MasterKey,
  input: { candidateId: CandidateId; tenantKey: string; actor: string; password: VaultSecret },
): Promise<Result<{ secretId: string; version: number }, InvalidVaultInput>> {
  const sealed = sealSecret(masterKey, input.candidateId, input.tenantKey, input.password);
  return ports.storeSealedSecret({
    candidateId: input.candidateId,
    tenantKey: input.tenantKey,
    actor: input.actor,
    sealed,
  });
}
