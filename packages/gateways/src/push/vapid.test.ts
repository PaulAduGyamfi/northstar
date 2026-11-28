import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  loadVapidConfig,
  VAPID_TTL_SECONDS,
  VapidConfigError,
  vapidAuthorization,
} from "./vapid.js";

// A key pair made for the test run: never a real key.
function rawPair() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  const pub = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x ?? "", "base64url"),
    Buffer.from(jwk.y ?? "", "base64url"),
  ]).toString("base64url");
  return { publicKey: pub, privateKey: jwk.d ?? "" };
}

const SUBJECT = "mailto:push@example.com";
const env = (pair = rawPair()) => ({
  PUSH_VAPID_PUBLIC_KEY: pair.publicKey,
  PUSH_VAPID_PRIVATE_KEY: pair.privateKey,
  PUSH_VAPID_SUBJECT: SUBJECT,
});

describe("loadVapidConfig (NS-193, ADR-0032 item 1)", () => {
  it("is null when no PUSH_VAPID_* setting is set, so push stays off", () => {
    expect(loadVapidConfig({})).toBeNull();
  });

  it("refuses a partial set, naming the missing setting", () => {
    const { PUSH_VAPID_SUBJECT: _, ...partial } = env();
    expect(() => loadVapidConfig(partial)).toThrow(
      "PUSH_VAPID_SUBJECT must be set with the other PUSH_VAPID_* settings",
    );
  });

  it("refuses the example file's placeholder", () => {
    expect(() => loadVapidConfig({ ...env(), PUSH_VAPID_PRIVATE_KEY: "change-me" })).toThrow(
      "PUSH_VAPID_PRIVATE_KEY must be set with the other PUSH_VAPID_* settings",
    );
  });

  it("refuses a public key that isn't the private key's own, without printing either", () => {
    const a = rawPair();
    const b = rawPair();
    const error = (() => {
      try {
        loadVapidConfig(env({ publicKey: b.publicKey, privateKey: a.privateKey }));
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(VapidConfigError);
    expect(error?.message).toBe("PUSH_VAPID_PUBLIC_KEY is not PUSH_VAPID_PRIVATE_KEY's public key");
    expect(error?.message).not.toContain(a.privateKey);
  });

  it("refuses a key of the wrong length", () => {
    expect(() => loadVapidConfig({ ...env(), PUSH_VAPID_PRIVATE_KEY: "AAAA" })).toThrow(
      "PUSH_VAPID_PRIVATE_KEY must be 32 bytes",
    );
  });

  it("refuses a subject that isn't a mailto: or https: URL", () => {
    expect(() => loadVapidConfig({ ...env(), PUSH_VAPID_SUBJECT: "http://example.com" })).toThrow(
      "PUSH_VAPID_SUBJECT must be a mailto: or https: URL",
    );
  });

  it("never shows the private key when the config is printed", () => {
    const e = env();
    const config = loadVapidConfig(e);
    expect(JSON.stringify(config)).not.toContain(e.PUSH_VAPID_PRIVATE_KEY);
    expect(String(config?.privateKey)).not.toContain(e.PUSH_VAPID_PRIVATE_KEY);
  });
});

describe("vapidAuthorization (NS-193, RFC 8292)", () => {
  it("signs an ES256 token for the endpoint's origin that the public key verifies", () => {
    const e = env();
    const config = loadVapidConfig(e);
    if (!config) throw new Error("no config");
    const now = new Date("2026-11-28T12:00:00.000Z");
    const header = vapidAuthorization(
      config,
      new URL("https://fcm.googleapis.com/fcm/send/abc"),
      now,
    );
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, h, c, sig, k] = match as unknown as [string, string, string, string, string];
    expect(k).toBe(e.PUSH_VAPID_PUBLIC_KEY);
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({
      typ: "JWT",
      alg: "ES256",
    });
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: Math.floor(now.getTime() / 1000) + VAPID_TTL_SECONDS,
      sub: SUBJECT,
    });
    const ok = verify(
      "sha256",
      Buffer.from(`${h}.${c}`),
      { key: createPublicKey(config.privateKey), dsaEncoding: "ieee-p1363" },
      Buffer.from(sig, "base64url"),
    );
    expect(ok).toBe(true);
  });
});
