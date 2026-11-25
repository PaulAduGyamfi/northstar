import { describe, expect, it } from "vitest";
import { loadApiConfig, loadExtensionTokenHash } from "./config.js";

// A made-up hash (sha256 of "test-key"); never a real key.
const HASH = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef";

describe("loadApiConfig", () => {
  it("reads the key hash and defaults the port and web origin", () => {
    expect(loadApiConfig({ NORTHSTAR_SIGNIN_KEY_SHA256: HASH })).toEqual({
      signinKeySha256: HASH,
      port: 8787,
      webOrigin: "http://northstar.localhost:3100",
    });
  });

  it("refuses the change-me placeholder and names the setting, never the value", () => {
    expect(() => loadApiConfig({ NORTHSTAR_SIGNIN_KEY_SHA256: "change-me" })).toThrow(
      "NORTHSTAR_SIGNIN_KEY_SHA256 must be the SHA-256 of your sign-in key (64 lowercase hex)",
    );
  });

  it("refuses a missing key hash", () => {
    expect(() => loadApiConfig({})).toThrow(/NORTHSTAR_SIGNIN_KEY_SHA256/);
  });

  it("refuses a web origin with a path, since browsers send an origin without one", () => {
    expect(() =>
      loadApiConfig({
        NORTHSTAR_SIGNIN_KEY_SHA256: HASH,
        NORTHSTAR_WEB_ORIGIN: "http://127.0.0.1:3100/app",
      }),
    ).toThrow(
      "NORTHSTAR_WEB_ORIGIN must be an http(s) origin such as http://northstar.localhost:3100",
    );
  });

  it("reads a port and web origin when set", () => {
    expect(
      loadApiConfig({
        NORTHSTAR_SIGNIN_KEY_SHA256: HASH,
        NORTHSTAR_API_PORT: "9100",
        NORTHSTAR_WEB_ORIGIN: "http://localhost:4000",
      }),
    ).toEqual({ signinKeySha256: HASH, port: 9100, webOrigin: "http://localhost:4000" });
  });
});

describe("loadExtensionTokenHash", () => {
  it("is null when the extension token isn't set, so every extension request is refused", () => {
    expect(loadExtensionTokenHash({})).toBeNull();
  });

  it("is null for the change-me placeholder", () => {
    expect(loadExtensionTokenHash({ NORTHSTAR_EXTENSION_TOKEN_SHA256: "change-me" })).toBeNull();
  });

  it("reads a SHA-256 when set", () => {
    expect(loadExtensionTokenHash({ NORTHSTAR_EXTENSION_TOKEN_SHA256: HASH })).toBe(HASH);
  });

  it("refuses anything else that is set, naming the setting", () => {
    expect(() => loadExtensionTokenHash({ NORTHSTAR_EXTENSION_TOKEN_SHA256: "abc" })).toThrow(
      "NORTHSTAR_EXTENSION_TOKEN_SHA256 must be the SHA-256 of the extension token (64 lowercase hex), or change-me to leave the extension off",
    );
  });
});
