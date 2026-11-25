import { createCipheriv, randomBytes } from "node:crypto";
import type { SealedSecret } from "@northstar/db";
import type { CandidateId } from "@northstar/domain";
import { keyBytes, type MasterKey } from "./key.js";
import type { VaultSecret } from "./secret.js";

// Envelope encryption (NS-122, CRD-001). Each secret gets a fresh 256-bit data key; the secret
// is encrypted with AES-256-GCM under it, and the data key with AES-256-GCM under the master
// key. Both carry associated data naming the candidate and tenant, so a sealed row copied onto
// another tenant or candidate won't open. Sealing needs no audit (nothing is revealed); opening
// is in open.ts.

const IV_BYTES = 12;
const DATA_KEY_BYTES = 32;

// The associated data for one tenant's secret; `part` keeps the two layers apart.
export const associatedData = (
  candidateId: CandidateId,
  tenantKey: string,
  part: "key" | "secret",
): Buffer => Buffer.from(`northstar-vault:v1:${part}:${candidateId}:${tenantKey}`, "utf8");

function encrypt(key: Uint8Array, plaintext: Uint8Array, aad: Buffer) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ciphertext, tag: cipher.getAuthTag() };
}

export function sealSecret(
  masterKey: MasterKey,
  candidateId: CandidateId,
  tenantKey: string,
  secret: VaultSecret,
): SealedSecret {
  const plaintext = Buffer.from(secret.reveal(), "utf8");
  if (plaintext.length === 0) throw new Error("vault: nothing to seal");
  const dataKey = randomBytes(DATA_KEY_BYTES);
  try {
    const inner = encrypt(dataKey, plaintext, associatedData(candidateId, tenantKey, "secret"));
    const wrapped = encrypt(
      keyBytes(masterKey),
      dataKey,
      associatedData(candidateId, tenantKey, "key"),
    );
    return {
      masterKeyId: masterKey.id,
      wrappedKeyIv: wrapped.iv,
      wrappedKey: wrapped.ciphertext,
      wrappedKeyTag: wrapped.tag,
      iv: inner.iv,
      ciphertext: inner.ciphertext,
      tag: inner.tag,
    };
  } finally {
    // Don't leave the plaintext data key or secret bytes around longer than needed.
    dataKey.fill(0);
    plaintext.fill(0);
  }
}
