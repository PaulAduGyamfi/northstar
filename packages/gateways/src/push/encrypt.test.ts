import { describe, expect, it } from "vitest";
import { encryptPayload, PushEncryptError } from "./encrypt.js";

const b = (s: string) => Buffer.from(s, "base64url");

// RFC 8291 Appendix A: the published example, key for key.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  message:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("encryptPayload (NS-193, RFC 8291)", () => {
  it("reproduces RFC 8291 Appendix A's message byte for byte", () => {
    const out = encryptPayload(
      Buffer.from(RFC.plaintext),
      { p256dh: b(RFC.uaPublic), auth: b(RFC.auth) },
      { privateKey: b(RFC.asPrivate), salt: b(RFC.salt) },
    );
    expect(out.toString("base64url")).toBe(RFC.message);
  });

  it("uses a fresh salt and sender key for every message", () => {
    // No decryption here: only src/vault/open.ts may call the decipher (CRD-002's boundary test).
    // The RFC vector above proves the encryption; this proves the salt and key id are fresh.
    const keys = { p256dh: b(RFC.uaPublic), auth: b(RFC.auth) };
    const one = encryptPayload(Buffer.from("hello"), keys);
    const two = encryptPayload(Buffer.from("hello"), keys);
    // Bytes 0-15 are the salt, 21-85 the sender's one-time public key.
    expect([
      one.subarray(0, 16).equals(two.subarray(0, 16)),
      one.subarray(21, 86).equals(two.subarray(21, 86)),
      one.length,
    ]).toEqual([false, false, 21 + 65 + 5 + 1 + 16]);
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
