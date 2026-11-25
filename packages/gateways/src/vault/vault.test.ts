import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import type { SealedVersion } from "@northstar/db";
import { CandidateId } from "@northstar/domain";
import { describe, expect, it } from "vitest";
import { keyBytes, loadVaultKey, masterKeyFrom } from "./key.js";
import { openSecret } from "./open.js";
import { sealSecret } from "./seal.js";
import { VaultSecret } from "./secret.js";
import { generateTenantPassword, TENANT_PASSWORD_LENGTH } from "./store.js";

// Sealing and opening on synthetic keys and passwords (no real secret anywhere).

const CANDIDATE = CandidateId.parse("00000000-0000-4000-8000-000000000001");
const OTHER_CANDIDATE = CandidateId.parse("00000000-0000-4000-8000-000000000002");
const KEY = masterKeyFrom(randomBytes(32));
const PASSWORD = "test-password-Xy7!";

const sealedRow = (tenantKey = "workday:acme", key = KEY): SealedVersion => ({
  ...sealSecret(key, CANDIDATE, tenantKey, new VaultSecret(PASSWORD)),
  secretId: "00000000-0000-4000-8000-0000000000aa",
  tenantKey,
  version: 1,
});

const flip = (bytes: Uint8Array): Uint8Array => {
  const copy = Uint8Array.from(bytes);
  copy[0] = (copy[0] ?? 0) ^ 0xff;
  return copy;
};

describe("sealSecret and openSecret", () => {
  it("open returns the sealed password under the same master key", () => {
    const opened = openSecret(KEY, CANDIDATE, sealedRow());
    expect(opened.ok && opened.value.reveal()).toBe(PASSWORD);
  });

  it("never puts the password in the sealed row's bytes", () => {
    const row = sealedRow();
    const all = Buffer.concat([row.wrappedKey, row.ciphertext, row.iv, row.tag]);
    expect(all.includes(Buffer.from(PASSWORD))).toBe(false);
  });

  it("seals the same password differently each time", () => {
    const [a, b] = [sealedRow(), sealedRow()];
    expect([
      Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext)),
      Buffer.from(a.wrappedKey).equals(Buffer.from(b.wrappedKey)),
    ]).toEqual([false, false]);
  });

  it("reports VaultKeyMismatch under another master key", () => {
    expect(openSecret(masterKeyFrom(randomBytes(32)), CANDIDATE, sealedRow())).toEqual({
      ok: false,
      error: { kind: "VaultKeyMismatch" },
    });
  });

  it.each(["ciphertext", "tag", "iv", "wrappedKey", "wrappedKeyTag", "wrappedKeyIv"] as const)(
    "reports VaultTampered when %s changed",
    (field) => {
      const row = sealedRow();
      expect(openSecret(KEY, CANDIDATE, { ...row, [field]: flip(row[field]) })).toEqual({
        ok: false,
        error: { kind: "VaultTampered" },
      });
    },
  );

  it("won't open a row moved to another tenant", () => {
    const row = { ...sealedRow("workday:acme"), tenantKey: "workday:globex" };
    expect(openSecret(KEY, CANDIDATE, row)).toEqual({
      ok: false,
      error: { kind: "VaultTampered" },
    });
  });

  it("won't open a row moved to another candidate", () => {
    expect(openSecret(KEY, OTHER_CANDIDATE, sealedRow())).toEqual({
      ok: false,
      error: { kind: "VaultTampered" },
    });
  });
});

describe("VaultSecret", () => {
  it("prints [redacted] in strings, JSON and inspect", () => {
    const secret = new VaultSecret(PASSWORD);
    expect([`${secret}`, JSON.stringify({ secret }), inspect(secret)]).toEqual([
      "[redacted]",
      '{"secret":"[redacted]"}',
      "[redacted]",
    ]);
  });
});

describe("loadVaultKey", () => {
  const keyFile = randomBytes(32).toString("base64");

  it("reads a base64 key file and names the key by its fingerprint", async () => {
    const key = await loadVaultKey(
      { VAULT_MASTER_KEY_FILE: "/keys/vault.key" },
      async () => keyFile,
    );
    expect([key.id, keyBytes(key).length]).toEqual([
      masterKeyFrom(Buffer.from(keyFile, "base64")).id,
      32,
    ]);
  });

  it("says the setting is missing, and nothing else", async () => {
    await expect(loadVaultKey({}, async () => keyFile)).rejects.toThrow(
      "VAULT_MASTER_KEY_FILE is not set",
    );
  });

  it("says the file couldn't be read, without the path", async () => {
    const failing = loadVaultKey({ VAULT_MASTER_KEY_FILE: "/keys/secret-path.key" }, async () => {
      throw new Error("ENOENT /keys/secret-path.key");
    });
    await expect(failing).rejects.toThrow(/^VAULT_MASTER_KEY_FILE could not be read$/);
  });

  it.each([randomBytes(16).toString("base64"), "not base64 at all!", ""])(
    "refuses a key that isn't 32 bytes of base64",
    async (contents) => {
      await expect(
        loadVaultKey({ VAULT_MASTER_KEY_FILE: "/keys/vault.key" }, async () => contents),
      ).rejects.toThrow("VAULT_MASTER_KEY_FILE must hold 32 bytes as base64");
    },
  );
});

describe("generateTenantPassword", () => {
  it("is 24 characters with a lowercase letter, an uppercase letter, a digit and a symbol", () => {
    for (let i = 0; i < 50; i++) {
      const p = generateTenantPassword().reveal();
      expect([
        p.length,
        /[a-z]/.test(p),
        /[A-Z]/.test(p),
        /[0-9]/.test(p),
        /[!#$%&*+\-=?@^_]/.test(p),
      ]).toEqual([TENANT_PASSWORD_LENGTH, true, true, true, true]);
    }
  });

  it("gives a different password each time", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateTenantPassword().reveal()));
    expect(seen.size).toBe(50);
  });
});

describe("MasterKey", () => {
  it("shows only its fingerprint's start in strings, JSON and inspect", () => {
    const key = masterKeyFrom(randomBytes(32));
    const shown = `[vault key ${key.id.slice(0, 8)}]`;
    expect([`${key}`, JSON.stringify({ key }), inspect(key), Object.keys(key)]).toEqual([
      shown,
      JSON.stringify({ key: shown }),
      shown,
      ["id"],
    ]);
  });
});
