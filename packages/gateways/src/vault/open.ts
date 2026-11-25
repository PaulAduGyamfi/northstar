import { createDecipheriv } from "node:crypto";
import type {
  InvalidVaultInput,
  NotApproved,
  OpenInput,
  SealedVersion,
  SecretNotFound,
  VaultLocked,
} from "@northstar/db";
import { type CandidateId, err, ok, type Result } from "@northstar/domain";
import { keyBytes, type MasterKey } from "./key.js";
import { associatedData } from "./seal.js";
import { VaultSecret } from "./secret.js";

// Opening a vault secret (NS-122, CRD-002/003). The only decrypt in Northstar. This module is
// internal to @northstar/gateways: it is never exported from the package, and a boundary test
// fails if any file outside packages/gateways/src imports it. The database records the access
// before handing out the sealed row, so every attempt is audited, including one that then fails
// to decrypt.

// The row was wrapped by another master key.
export type VaultKeyMismatch = { kind: "VaultKeyMismatch" };
// The row doesn't decrypt under its own key: changed, or copied from another tenant.
export type VaultTampered = { kind: "VaultTampered" };
export type OpenError =
  | InvalidVaultInput
  | NotApproved
  | VaultLocked
  | SecretNotFound
  | VaultKeyMismatch
  | VaultTampered;

export type OpenPorts = {
  openSealedSecret: (
    input: OpenInput,
  ) => Promise<
    Result<SealedVersion, InvalidVaultInput | NotApproved | VaultLocked | SecretNotFound>
  >;
};

function decrypt(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  aad: Buffer,
): Buffer | null {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // GCM refuses a wrong key, tag, IV, AAD or ciphertext the same way; say only that.
    return null;
  }
}

// Decrypts one sealed row. Pure: no I/O, no audit (useTenantPassword does that first).
export function openSecret(
  masterKey: MasterKey,
  candidateId: CandidateId,
  sealed: SealedVersion,
): Result<VaultSecret, VaultKeyMismatch | VaultTampered> {
  if (sealed.masterKeyId !== masterKey.id) return err({ kind: "VaultKeyMismatch" });
  const dataKey = decrypt(
    keyBytes(masterKey),
    sealed.wrappedKeyIv,
    sealed.wrappedKey,
    sealed.wrappedKeyTag,
    associatedData(candidateId, sealed.tenantKey, "key"),
  );
  if (dataKey === null) return err({ kind: "VaultTampered" });
  try {
    const plaintext = decrypt(
      dataKey,
      sealed.iv,
      sealed.ciphertext,
      sealed.tag,
      associatedData(candidateId, sealed.tenantKey, "secret"),
    );
    if (plaintext === null) return err({ kind: "VaultTampered" });
    const secret = new VaultSecret(plaintext.toString("utf8"));
    plaintext.fill(0);
    return ok(secret);
  } finally {
    dataKey.fill(0);
  }
}

// The Apply Gateway's way to use a tenant password. The database checks the vault isn't locked
// and the decision is a live approval (refusing rejected, undone or not-yet-effective ones),
// records the access, then this decrypts. The caller still runs verifyApproval for the action
// it serves first, which also checks the decision covers that exact content (ADR-0002).
export async function useTenantPassword(
  ports: OpenPorts,
  masterKey: MasterKey,
  input: OpenInput,
): Promise<Result<VaultSecret, OpenError>> {
  const sealed = await ports.openSealedSecret(input);
  if (!sealed.ok) return sealed;
  return openSecret(masterKey, input.candidateId, sealed.value);
}
