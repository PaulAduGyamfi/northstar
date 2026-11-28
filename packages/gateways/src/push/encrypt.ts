import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

// Web push message encryption (NS-193, ADR-0032 item 2): RFC 8291 over RFC 8188's `aes128gcm`
// content coding, one record. Built on node:crypto only; `encrypt.test.ts` checks it byte for
// byte against RFC 8291 Appendix A, so any change here must keep that vector passing.

// A browser subscription's keys (PushSubscription.getKey): its P-256 public point and auth secret.
export type SubscriptionKeys = { p256dh: Buffer; auth: Buffer };

// The sender's one-time key and salt. Fresh for every message; injectable only for the RFC test.
export type Ephemeral = { privateKey: Buffer; salt: Buffer };

// An uncompressed P-256 point: 0x04, then 32 bytes of x and 32 of y.
const POINT_BYTES = 65;
const AUTH_BYTES = 16;
const SALT_BYTES = 16;
// One record holds the whole payload: 4096 is the record size RFC 8291 section 4 uses, and
// payloads are capped far below it (MAX_PUSH_PAYLOAD_BYTES).
const RECORD_SIZE = 4096;
// AES-GCM tag (16) and the padding delimiter (1) share the record with the payload.
const MAX_PLAINTEXT = RECORD_SIZE - 16 - 1;

export class PushEncryptError extends Error {
  override name = "PushEncryptError";
}

const info = (label: string) => Buffer.concat([Buffer.from(label, "ascii"), Buffer.from([0])]);
const hkdf = (ikm: Buffer, salt: Buffer, i: Buffer, length: number) =>
  Buffer.from(hkdfSync("sha256", ikm, salt, i, length));

// Encrypts `plaintext` for one subscription and returns the request body: the RFC 8188 header
// (salt, record size, key id = the sender's public point) followed by the single record.
export function encryptPayload(
  plaintext: Buffer,
  keys: SubscriptionKeys,
  ephemeral: Ephemeral = { privateKey: randomBytes(32), salt: randomBytes(SALT_BYTES) },
): Buffer {
  if (keys.p256dh.length !== POINT_BYTES || keys.p256dh[0] !== 0x04) {
    throw new PushEncryptError("p256dh is not an uncompressed P-256 point");
  }
  if (keys.auth.length !== AUTH_BYTES) throw new PushEncryptError("auth is not 16 bytes");
  if (ephemeral.salt.length !== SALT_BYTES) throw new PushEncryptError("salt is not 16 bytes");
  if (plaintext.length > MAX_PLAINTEXT) throw new PushEncryptError("payload too long");

  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(ephemeral.privateKey);
  const asPublic = ecdh.getPublicKey();
  // Throws on a point that isn't on the curve: a bad subscription, never sent.
  let ecdhSecret: Buffer;
  try {
    ecdhSecret = ecdh.computeSecret(keys.p256dh);
  } catch {
    throw new PushEncryptError("p256dh is not a valid P-256 point");
  }

  // RFC 8291 section 3.4: mix the auth secret and both public keys into the input keying material.
  const keyInfo = Buffer.concat([info("WebPush: info"), keys.p256dh, asPublic]);
  const ikm = hkdf(ecdhSecret, keys.auth, keyInfo, 32);
  // RFC 8188 section 2.2: the content key and nonce from the salt.
  const cek = hkdf(ikm, ephemeral.salt, info("Content-Encoding: aes128gcm"), 16);
  const nonce = hkdf(ikm, ephemeral.salt, info("Content-Encoding: nonce"), 12);

  // The last (only) record ends with the 0x02 delimiter and no further padding.
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const record = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(SALT_BYTES + 4 + 1);
  ephemeral.salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, SALT_BYTES);
  header.writeUInt8(asPublic.length, SALT_BYTES + 4);
  return Buffer.concat([header, asPublic, record]);
}
