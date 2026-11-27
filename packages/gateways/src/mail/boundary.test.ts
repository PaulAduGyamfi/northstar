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

// The tests below that read every source file in the repository get their own time limit
// (NS-258): alone they take well under a second, but CI runs every package's tests at once and
// one walk took 5,025 ms against vitest's 5,000 ms default. A slow disk, not a slow check.
const REPO_WALK_TIMEOUT_MS = 30_000;

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

// Source without its comments, so a comment that mentions the global fetch never trips a rule.
// Rough (a `//` inside a string is cut too), which only ever hides text, never adds a match.
const withoutComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// An import, re-export or require of a path ending in mail/drafts, mail/message, mail/access or
// (NS-237 slice 5) mail/consent, whose test seam takes a token exchange that sees the raw token.
// `from "…"`, `import("…")`, a bare `import "…"` (which still runs the module) and `require("…")`.
const IMPORTS_PRIVATE =
  /(from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["'][^"']*mail\/(drafts|message|access|consent)(\.[a-z]+)?["']/;
const ENTRY = "packages/gateways/src/index.ts";

// The private imports one file makes, other than the package entry's allowed exports (the token
// type and the consent flow's public entry point).
function privateImports(path: string, text: string): string[] {
  const matches = text.match(new RegExp(IMPORTS_PRIVATE, "g")) ?? [];
  if (path !== ENTRY) return matches;
  return matches.filter((m) => !/mail\/(access|consent)(\.js)?["']$/.test(m));
}

// Gmail's send, update and delete calls on drafts and messages, as a URL path or a method name.
const WRITES_BEYOND_CREATE = [
  /\/send\b/,
  /drafts\.(send|update|delete)\b/,
  /messages\.(send|insert|import|modify|trash|delete|batchModify|batchDelete)\b/,
  /\/(trash|modify|batchModify|batchDelete|import)\b/,
  /method:\s*["'](PUT|PATCH|DELETE)["']/,
];

describe("the draft writer's boundary (ADR-0025 item 4)", () => {
  it(
    "no file outside src/mail/ imports its Gmail requests, message builder or token module",
    async () => {
      const found: string[] = [];
      for (const file of await sources(repoRoot)) {
        const path = rel(file);
        // The package entry exports the token type (from access.ts) for the coming consent flow.
        if (path.startsWith(MAIL_DIR)) continue;
        if (privateImports(path, await readFile(file, "utf8")).length > 0) found.push(path);
      }
      expect(found).toEqual([]);
    },
    REPO_WALK_TIMEOUT_MS,
  );

  it("catches every form of private import, bare imports included, and allows only the entry's exports", () => {
    expect([
      privateImports("apps/api/src/x.ts", 'import "../../../packages/gateways/src/mail/drafts.js";')
        .length,
      privateImports(
        "apps/api/src/x.ts",
        'const d = require("@northstar/gateways/src/mail/drafts");',
      ).length,
      privateImports("packages/gateways/src/apply/x.ts", 'import { x } from "../mail/message.js";')
        .length,
      privateImports("packages/gateways/src/apply/x.ts", 'await import("../mail/consent.js");')
        .length,
      privateImports(ENTRY, 'export { GmailComposeAccess } from "./mail/access.js";').length,
      privateImports(ENTRY, 'export { authorizeCompose } from "./mail/consent.js";').length,
      privateImports(ENTRY, 'import "./mail/drafts.js";').length,
    ]).toEqual([1, 1, 1, 1, 0, 0, 1]);
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
    // `export *` would re-export it without naming it: refuse it for every mail module, and check
    // what the entry really exports at run time.
    expect(entry).not.toMatch(/export\s*\*[^;]*mail\//);
  });

  // Loading the whole package entry (the database, the browser driver and the rest) took over the
  // default 5 s on CI's busy runners, so this one check gets its own, longer limit.
  it("the package entry's run-time exports don't include the consent flow's test seam", async () => {
    expect(Object.keys(await import("../index.js"))).not.toContain("authorizeComposeWith");
  }, 30_000);

  it("no code under src/mail/ takes a fetch from its caller, which would see the compose token", async () => {
    // Any fetch-shaped port, whatever its name: `typeof fetch`, or a function returning a Response.
    const FETCH_PORT = [/\btypeof\s+(globalThis\.)?fetch\b/, /=>\s*Promise<\s*Response\s*>/];
    const found: string[] = [];
    for (const file of await sources(join(repoRoot, MAIL_DIR))) {
      const path = rel(file);
      // Tests stand fakes in for the global fetch.
      if (path.endsWith(".test.ts") || path.startsWith(`${MAIL_DIR}test/`)) continue;
      const code = withoutComments(await readFile(file, "utf8"));
      for (const pattern of FETCH_PORT) if (pattern.test(code)) found.push(`${path}: ${pattern}`);
    }
    expect(found).toEqual([]);
  });

  it(
    "no code outside tests replaces the global fetch, which sees the compose token's requests",
    async () => {
      // The writer's requests go through the global fetch, so code in the same process that swaps it
      // could read the token (review of NS-237 slice 5). Only tests may stand a fake in for it.
      const PATCHES = [
        /globalThis\.fetch\s*=(?!=)/,
        /stubGlobal\(\s*["'`]fetch["'`]/,
        /defineProperty\(\s*globalThis\s*,\s*["'`]fetch["'`]/,
      ];
      const found: string[] = [];
      for (const file of await sources(repoRoot)) {
        const path = rel(file);
        if (/\.test\.[a-z]+$/.test(path) || path.includes("/test/")) continue;
        const code = withoutComments(await readFile(file, "utf8"));
        for (const pattern of PATCHES) if (pattern.test(code)) found.push(`${path}: ${pattern}`);
      }
      expect(found).toEqual([]);
    },
    REPO_WALK_TIMEOUT_MS,
  );

  it(
    "only src/mail/drafts.ts reads the compose token back (bearerOf)",
    async () => {
      const found: string[] = [];
      for (const file of await sources(repoRoot)) {
        const path = rel(file);
        if (path === `${MAIL_DIR}drafts.ts` || path === `${MAIL_DIR}access.ts`) continue;
        if (path === `${MAIL_DIR}boundary.test.ts`) continue;
        if (/\bbearerOf\b/.test(await readFile(file, "utf8"))) found.push(path);
      }
      expect(found).toEqual([]);
    },
    REPO_WALK_TIMEOUT_MS,
  );
});
