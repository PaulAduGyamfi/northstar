import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encryptPayload, PushEncryptError } from "./encrypt.js";

const b = (s: string) => Buffer.from(s, "base64url");

// RFC 8291 Appendix A: the published example, key for key.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  message:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

// The browser's side of RFC 8291, for round trips: what a user agent does with the body.
function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(asPublic);
  const nul = Buffer.from([0]);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info"), nul, uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, auth, keyInfo, 32));
  const label = (s: string) => Buffer.concat([Buffer.from(s), nul]);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, label("Content-Encoding: aes128gcm"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, label("Content-Encoding: nonce"), 12));
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()]);
  expect(padded[padded.length - 1]).toBe(2);
  return padded.subarray(0, padded.length - 1).toString("utf8");
}

describe("encryptPayload (NS-193, RFC 8291)", () => {
  it("reproduces RFC 8291 Appendix A's message byte for byte", () => {
    const out = encryptPayload(
      Buffer.from(RFC.plaintext),
      { p256dh: b(RFC.uaPublic), auth: b(RFC.auth) },
      { privateKey: b(RFC.asPrivate), salt: b(RFC.salt) },
    );
    expect(out.toString("base64url")).toBe(RFC.message);
  });

  it("uses a fresh key and salt each time, and the browser can still read it", () => {
    const keys = { p256dh: b(RFC.uaPublic), auth: b(RFC.auth) };
    const one = encryptPayload(Buffer.from("hello"), keys);
    const two = encryptPayload(Buffer.from("hello"), keys);
    expect(one.equals(two)).toBe(false);
    expect([
      decrypt(one, b(RFC.uaPrivate), b(RFC.auth)),
      decrypt(two, b(RFC.uaPrivate), b(RFC.auth)),
    ]).toEqual(["hello", "hello"]);
  });

  it("refuses a p256dh that isn't an uncompressed point on the curve", () => {
    const auth = b(RFC.auth);
    const bad = Buffer.alloc(65, 0);
    bad[0] = 4;
    for (const p256dh of [Buffer.alloc(33, 2), b(RFC.uaPublic).subarray(1), bad]) {
      expect(() => encryptPayload(Buffer.from("x"), { p256dh, auth })).toThrow(PushEncryptError);
    }
  });

  it("refuses an auth secret that isn't 16 bytes", () => {
    expect(() =>
      encryptPayload(Buffer.from("x"), { p256dh: b(RFC.uaPublic), auth: Buffer.alloc(8) }),
    ).toThrow("auth is not 16 bytes");
  });

  it("refuses a payload too long for one record", () => {
    expect(() =>
      encryptPayload(Buffer.alloc(4080), { p256dh: b(RFC.uaPublic), auth: b(RFC.auth) }),
    ).toThrow("payload too long");
  });
});
