import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ADR-0025 item 4: the draft writer creates drafts and nothing else. Its Gmail requests
// (src/mail/drafts.ts), the message builder and the compose token's module are imported only from
// inside src/mail/, and no code under src/mail/ names a send, update or delete on drafts or
// messages. The runtime allowlist (drafts.test.ts) is the second line.

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const MAIL_DIR = "packages/gateways/src/mail/";
const LOCAL_ONLY = ["data", "private", "exports", "build", "coverage"];

// Every TypeScript and JavaScript source in the repo, skipping builds, dependencies, dot folders
// and Paul's gitignored local folders.
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
    if (dir === repoRoot && LOCAL_ONLY.includes(e.name)) continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await sources(path)));
    else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(e.name)) out.push(path);
  }
  return out;
}

const rel = (file: string) => relative(repoRoot, file).split(sep).join("/");

// An import, re-export or require of a path ending in mail/drafts, mail/message, mail/access or
// (NS-237 slice 5) mail/consent, whose test seam takes a token exchange that sees the raw token.
const IMPORTS_PRIVATE =
  /(from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*mail\/(drafts|message|access|consent)(\.[a-z]+)?["']/;

// Gmail's send, update and delete calls on drafts and messages, as a URL path or a method name.
const WRITES_BEYOND_CREATE = [
  /\/send\b/,
  /drafts\.(send|update|delete)\b/,
  /messages\.(send|insert|import|modify|trash|delete|batchModify|batchDelete)\b/,
  /\/(trash|modify|batchModify|batchDelete|import)\b/,
  /method:\s*["'](PUT|PATCH|DELETE)["']/,
];

describe("the draft writer's boundary (ADR-0025 item 4)", () => {
  it("no file outside src/mail/ imports its Gmail requests, message builder or token module", async () => {
    const found: string[] = [];
    for (const file of await sources(repoRoot)) {
      const path = rel(file);
      // The package entry exports the token type (from access.ts) for the coming consent flow.
      if (path.startsWith(MAIL_DIR)) continue;
      const text = await readFile(file, "utf8");
      const matches = text.match(new RegExp(IMPORTS_PRIVATE, "g")) ?? [];
      // The package entry exports the token type and the consent flow's public entry point only.
      const allowed = path === "packages/gateways/src/index.ts";
      if (matches.some((m) => !(allowed && /mail\/(access|consent)(\.js)?["']$/.test(m))))
        found.push(path);
    }
    expect(found).toEqual([]);
  });

  it("no code under src/mail/ names a send, update or delete on Gmail drafts or messages", async () => {
    const found: string[] = [];
    for (const file of await sources(join(repoRoot, MAIL_DIR))) {
      const path = rel(file);
      // Tests name these calls to prove the allowlist refuses them.
      if (path.endsWith(".test.ts")) continue;
      const text = await readFile(file, "utf8");
      for (const pattern of WRITES_BEYOND_CREATE)
        if (pattern.test(text)) found.push(`${path}: ${pattern}`);
    }
    expect(found).toEqual([]);
  });

  it("the package entry never exports the consent flow's test seam (authorizeComposeWith)", async () => {
    const entry = await readFile(join(repoRoot, "packages/gateways/src/index.ts"), "utf8");
    expect(entry).not.toMatch(/\bauthorizeComposeWith\b/);
  });

  it("only src/mail/drafts.ts reads the compose token back (bearerOf)", async () => {
    const found: string[] = [];
    for (const file of await sources(repoRoot)) {
      const path = rel(file);
      if (path === `${MAIL_DIR}drafts.ts` || path === `${MAIL_DIR}access.ts`) continue;
      if (path === `${MAIL_DIR}boundary.test.ts`) continue;
      if (/\bbearerOf\b/.test(await readFile(file, "utf8"))) found.push(path);
    }
    expect(found).toEqual([]);
  });
});
