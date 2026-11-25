import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as gateways from "../index.js";

// CRD-002 / ADR-0010 item 2: only the Apply Gateway can decrypt. The decrypt module
// (src/vault/open.ts) is internal to this package: nothing outside packages/gateways/src imports
// it, and the package's public entry doesn't export it.

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

// Every TypeScript source in the repo's packages and apps, skipping builds and dependencies.
async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await sources(path)));
    else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(e.name)) out.push(path);
  }
  return out;
}

// An import or require of a path ending in vault/open (with or without an extension).
const IMPORTS_OPEN = /(from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*vault\/open(\.[a-z]+)?["']/;

const allSources = async (): Promise<string[]> => [
  ...(await sources(join(repoRoot, "packages"))),
  ...(await sources(join(repoRoot, "apps"))),
  ...(await sources(join(repoRoot, "evals"))),
];

// Files (relative to the repo root) where a pattern is found, outside the allowed ones.
async function offenders(pattern: RegExp, allowed: (rel: string) => boolean): Promise<string[]> {
  const found: string[] = [];
  for (const file of await allSources()) {
    const rel = relative(repoRoot, file).split(sep).join("/");
    if (allowed(rel)) continue;
    if (pattern.test(await readFile(file, "utf8"))) found.push(rel);
  }
  return found;
}

const VAULT_DIR = "packages/gateways/src/vault/";
const isVaultTest = (rel: string) => rel.startsWith(VAULT_DIR) && rel.endsWith(".test.ts");

// Each way to decrypt without useTenantPassword's audit and lock check, with the only files
// allowed to use it (security review of NS-122: an exported key or sealed rows plus ten lines of
// node:crypto would be a decrypt path of its own).
const DECRYPT = /\bcreateDecipheriv\b/;
const KEY_BYTES = /\b(keyBytes|bytesOf)\b/;
// The sealed-row table, but not the `vault_secret.stored` event or `vault_secret:<id>` aggregate.
const SEALED_ROWS = /\bvaultSecret\b|\bvault_secret\b(?![.:])/;

describe("the vault's decrypt boundary (CRD-002)", () => {
  it("no file outside packages/gateways/src imports the decrypt module", async () => {
    const found = await offenders(IMPORTS_OPEN, (rel) => rel.startsWith("packages/gateways/src/"));
    expect(found).toEqual([]);
  });

  it("only src/vault/open.ts calls createDecipheriv", async () => {
    const found = await offenders(
      DECRYPT,
      (rel) => rel === `${VAULT_DIR}open.ts` || rel === `${VAULT_DIR}boundary.test.ts`,
    );
    expect(found).toEqual([]);
  });

  it("only the vault's key, seal and open modules read the master key's bytes", async () => {
    const allowed = ["key.ts", "seal.ts", "open.ts"].map((f) => VAULT_DIR + f);
    const found = await offenders(KEY_BYTES, (rel) => allowed.includes(rel) || isVaultTest(rel));
    expect(found).toEqual([]);
  });

  it("only the vault's write path in packages/db reads sealed rows", async () => {
    const allowed = ["vault-schema.ts", "vault-write.ts", "vault.test.ts"].map(
      (f) => `packages/db/src/${f}`,
    );
    const found = await offenders(
      SEALED_ROWS,
      (rel) => allowed.includes(rel) || rel === `${VAULT_DIR}boundary.test.ts`,
    );
    expect(found).toEqual([]);
  });

  it("the checks above would catch each way in", () => {
    expect([
      DECRYPT.test(`const d = createDecipheriv("aes-256-gcm", k, iv);`),
      KEY_BYTES.test("const raw = keyBytes(key);"),
      SEALED_ROWS.test("db.select().from(vaultSchema.vaultSecret)"),
      SEALED_ROWS.test("select * from vault_secret"),
      SEALED_ROWS.test(`"vault_secret.stored"`),
    ]).toEqual([true, true, true, true, false]);
  });

  it("the check above would catch an import of the decrypt module", () => {
    expect(
      IMPORTS_OPEN.test(`import { openSecret } from "@northstar/gateways/src/vault/open.js";`),
    ).toBe(true);
  });

  it("@northstar/gateways doesn't export a decrypt function", () => {
    const names = Object.keys(gateways);
    expect(names.filter((n) => /^(openSecret|useTenantPassword)$|decrypt/i.test(n))).toEqual([]);
  });
});
