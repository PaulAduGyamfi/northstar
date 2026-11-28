import { createECDH, createPrivateKey, type KeyObject, sign } from "node:crypto";

// VAPID (RFC 8292) for web push (NS-193, ADR-0032 items 1 and 2): the sender's identity to the
// push services, from a P-256 key pair Paul generates himself. The private key is held only as a
// KeyObject, which never prints its material.

export type VapidConfig = {
  // The raw uncompressed public point (65 bytes); the browser subscribes with it.
  publicKey: Buffer;
  privateKey: KeyObject;
  // Paul's contact for the push services: a mailto: or https: URL.
  subject: string;
};

// How long a signed token is good for: RFC 8292 allows up to 24 hours; 12 leaves room for clocks.
export const VAPID_TTL_SECONDS = 12 * 60 * 60;

export class VapidConfigError extends Error {
  override name = "VapidConfigError";
}

const B64URL = /^[A-Za-z0-9_-]+$/;
// A placeholder from the example env file (`change-me`, `mailto:change-me@…`) is never a setting.
const PLACEHOLDER = "change-me";

function b64url(name: string, value: string, bytes: number): Buffer {
  if (!B64URL.test(value)) throw new VapidConfigError(`${name} must be base64url`);
  const raw = Buffer.from(value, "base64url");
  if (raw.length !== bytes) throw new VapidConfigError(`${name} must be ${bytes} bytes`);
  return raw;
}

// Builds the config from the raw keys, checking the public key is the private key's own.
export function vapidConfig(input: {
  publicKey: string;
  privateKey: string;
  subject: string;
}): VapidConfig {
  const publicKey = b64url("PUSH_VAPID_PUBLIC_KEY", input.publicKey, 65);
  const d = b64url("PUSH_VAPID_PRIVATE_KEY", input.privateKey, 32);
  if (publicKey[0] !== 0x04) {
    throw new VapidConfigError("PUSH_VAPID_PUBLIC_KEY must be an uncompressed P-256 point");
  }
  // The public point derived from d: a JWK's x and y are taken as given, never checked against d,
  // so the pair is checked here. A d outside the curve's range throws.
  let derived: Buffer;
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(d);
    derived = ecdh.getPublicKey();
  } catch {
    throw new VapidConfigError("PUSH_VAPID_PRIVATE_KEY is not a P-256 private key");
  }
  if (!derived.equals(publicKey)) {
    // The message names no key material.
    throw new VapidConfigError("PUSH_VAPID_PUBLIC_KEY is not PUSH_VAPID_PRIVATE_KEY's public key");
  }
  const privateKey = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: d.toString("base64url"),
      x: publicKey.subarray(1, 33).toString("base64url"),
      y: publicKey.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
  if (
    !/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(input.subject) ||
    input.subject.length > 200
  ) {
    throw new VapidConfigError("PUSH_VAPID_SUBJECT must be a mailto: or https: URL");
  }
  return { publicKey, privateKey, subject: input.subject };
}

// Reads the three PUSH_VAPID_* settings from the environment the entry point passes in. None set
// means push is off (null); some but not all, a placeholder or a bad key throws, naming the
// setting and never its value.
export function loadVapidConfig(
  env: Readonly<Record<string, string | undefined>>,
): VapidConfig | null {
  const names = ["PUSH_VAPID_PUBLIC_KEY", "PUSH_VAPID_PRIVATE_KEY", "PUSH_VAPID_SUBJECT"] as const;
  const values = names.map((n) => env[n]?.trim() || undefined);
  if (values.every((v) => v === undefined)) return null;
  names.forEach((name, i) => {
    const v = values[i];
    if (v === undefined || v.includes(PLACEHOLDER)) {
      throw new VapidConfigError(`${name} must be set with the other PUSH_VAPID_* settings`);
    }
  });
  const [publicKey, privateKey, subject] = values as [string, string, string];
  return vapidConfig({ publicKey, privateKey, subject });
}

// The Authorization header for one push: `vapid t=<ES256 JWT>, k=<public key>`, the token naming
// the endpoint's origin (`aud`) so it is good for that push service only.
export function vapidAuthorization(config: VapidConfig, endpoint: URL, now: Date): string {
  // A token for a non-https origin is never made: push services are https only (RFC 8030).
  if (endpoint.protocol !== "https:") throw new VapidConfigError("audience must be https");
  const header = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      aud: endpoint.origin,
      exp: Math.floor(now.getTime() / 1000) + VAPID_TTL_SECONDS,
      sub: config.subject,
    }),
  ).toString("base64url");
  const input = `${header}.${claims}`;
  // JWS ES256 wants the raw r||s signature, not DER.
  const signature = sign("sha256", Buffer.from(input), {
    key: config.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `vapid t=${input}.${signature}, k=${config.publicKey.toString("base64url")}`;
}
