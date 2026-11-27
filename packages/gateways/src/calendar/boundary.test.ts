import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ADR-0031 items 2 and 6: the Calendar writer inserts approved prep blocks and nothing else. Its
// requests (src/calendar/requests.ts), its token module and its consent flow are imported only from
// inside src/calendar/ (the package entry may export the token type and the consent entry point),
// and no code under src/calendar/ names an update, move or delete, or an event field the approval's
// hash doesn't cover. The runtime allowlist (requests.test.ts) is the second line.

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const CALENDAR_DIR = "packages/gateways/src/calendar/";
const ENTRY = "packages/gateways/src/index.ts";
const LOCAL_ONLY = ["data", "private", "exports", "build", "coverage"];
// Walking every source in the repository is slow on CI's busy runners (as in the mail boundary).
const REPO_WALK_TIMEOUT_MS = 30_000;

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
const withoutComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// An import, re-export or require of this package's calendar/requests, calendar/access or
// calendar/consent (whose test seam takes a token exchange that sees the raw token). Inside
// packages/gateways that is a relative `calendar/...` path; anywhere else it names the package's
// own src or dist folder. packages/inbox has a calendar/ folder of its own (the read-only client),
// which this doesn't match.
const PRIVATE = "calendar\\/(requests|access|consent)(\\.[a-z]+)?[\"']";
const IMPORT = "(from\\s+|import\\s*\\(\\s*|require\\s*\\(\\s*)[\"']";
const IMPORTS_PRIVATE_HERE = new RegExp(`${IMPORT}[^"']*${PRIVATE}`, "g");
const IMPORTS_PRIVATE_ELSEWHERE = new RegExp(
  `${IMPORT}[^"']*gateways\\/(src|dist)\\/${PRIVATE}`,
  "g",
);
const GATEWAYS_SRC = "packages/gateways/src/";

// Calendar calls beyond insert, and event fields outside the hash (ADR-0031 item 6).
const BEYOND_INSERT = [
  /method:\s*["'](PUT|PATCH|DELETE)["']/,
  /\/move\b/,
  /\/(quickAdd|import|watch|clear)\b/,
  /\bevents\.(update|patch|delete|move|quickAdd|import)\b/,
  /\bcalendars\.(update|patch|delete|clear)\b/,
  /\battendees\b/,
  /\bconferenceData(Version)?\b/,
  /\blocation\b/,
  /\breminders\b/,
  /\bguestsCan\w*/,
  /\bvisibility\b/,
  /sendUpdates=(all|externalOnly)/,
];

describe("the Calendar writer's boundary (ADR-0031)", () => {
  it(
    "no file outside src/calendar/ imports its requests, token module or consent flow",
    async () => {
      const found: string[] = [];
      for (const file of await sources(repoRoot)) {
        const path = rel(file);
        if (path.startsWith(CALENDAR_DIR)) continue;
        const text = await readFile(file, "utf8");
        const pattern = path.startsWith(GATEWAYS_SRC)
          ? IMPORTS_PRIVATE_HERE
          : IMPORTS_PRIVATE_ELSEWHERE;
        const matches = text.match(pattern) ?? [];
        const allowed = path === ENTRY;
        if (matches.some((m) => !(allowed && /calendar\/(access|consent)(\.js)?["']$/.test(m))))
          found.push(path);
      }
      expect(found).toEqual([]);
    },
    REPO_WALK_TIMEOUT_MS,
  );

  it("no code under src/calendar/ names an update, move or delete, or an unhashed event field", async () => {
    const found: string[] = [];
    for (const file of await sources(join(repoRoot, CALENDAR_DIR))) {
      const path = rel(file);
      // Tests name these to prove the allowlist refuses them.
      if (path.endsWith(".test.ts")) continue;
      const code = withoutComments(await readFile(file, "utf8"));
      for (const pattern of BEYOND_INSERT)
        if (pattern.test(code)) found.push(`${path}: ${pattern}`);
    }
    expect(found).toEqual([]);
  });

  it("no code under src/calendar/ takes a fetch from its caller, which would see the write token", async () => {
    const FETCH_PORT = [/\btypeof\s+(globalThis\.)?fetch\b/, /=>\s*Promise<\s*Response\s*>/];
    const found: string[] = [];
    for (const file of await sources(join(repoRoot, CALENDAR_DIR))) {
      const path = rel(file);
      if (path.endsWith(".test.ts")) continue;
      const code = withoutComments(await readFile(file, "utf8"));
      for (const pattern of FETCH_PORT) if (pattern.test(code)) found.push(`${path}: ${pattern}`);
    }
    expect(found).toEqual([]);
  });

  it(
    "only src/calendar/requests.ts reads the write token back (calendarBearer)",
    async () => {
      const found: string[] = [];
      for (const file of await sources(repoRoot)) {
        const path = rel(file);
        if (path === `${CALENDAR_DIR}requests.ts` || path === `${CALENDAR_DIR}access.ts`) continue;
        if (path === `${CALENDAR_DIR}boundary.test.ts`) continue;
        if (/\bcalendarBearer\b/.test(await readFile(file, "utf8"))) found.push(path);
      }
      expect(found).toEqual([]);
    },
    REPO_WALK_TIMEOUT_MS,
  );

  it("the package entry never exports the consent flow's test seam or the requests", async () => {
    // Comments may name the private files; only code counts.
    const entry = withoutComments(await readFile(join(repoRoot, ENTRY), "utf8"));
    expect([
      /\bauthorizeCalendarWriteWith\b/.test(entry),
      /calendar\/requests/.test(entry),
      /export\s*\*[^;]*calendar\//.test(entry),
    ]).toEqual([false, false, false]);
  });

  it("the package entry's run-time exports don't include the test seam or the requests client", async () => {
    const names = Object.keys(await import("../index.js"));
    expect(
      names.filter((n) => ["authorizeCalendarWriteWith", "createCalendarWriteClient"].includes(n)),
    ).toEqual([]);
  }, 30_000);
});
