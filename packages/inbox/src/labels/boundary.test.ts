import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ADR-0027: the label writer's token has gmail.modify, which can also send, trash and remove. The
// code under src/labels/ may only list labels, create labels and add labels to a thread. This text
// scan is a tripwire, not the guarantee: `requestAllowed` checks every request at run time.
const FORBIDDEN = [
  /\bsend\b/i,
  /\/trash\b/i,
  /\/untrash\b/i,
  /\bdelete\b/i,
  /removeLabelIds/,
  /\/drafts\b/i,
  /\/settings\b/i,
  /\/filters\b/i,
  /\/messages\b/,
  /batchModify/,
  // Any quote style, a template or a bare word: only GET and POST are ever sent.
  /\b(DELETE|PUT|PATCH)\b/,
];

// Comments are left out: the writer's comments say what it must never do.
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

export function forbiddenIn(source: string): string[] {
  const text = code(source);
  return FORBIDDEN.filter((p) => p.test(text)).map(String);
}

const dir = fileURLToPath(new URL(".", import.meta.url));
// Recursive: a file in a sub-folder is scanned too.
const sources = (readdirSync(dir, { recursive: true }) as string[]).filter(
  (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
);

describe("the label writer's boundary", () => {
  it.each(sources)("%s names no Gmail write beyond adding labels", (file) => {
    expect(forbiddenIn(readFileSync(`${dir}/${file}`, "utf8"))).toEqual([]);
  });

  it("catches a forbidden call if one is added", () => {
    expect(forbiddenIn('THREADS + "/" + id + "/trash"')).not.toEqual([]);
    expect(forbiddenIn("JSON.stringify({ removeLabelIds: ids })")).not.toEqual([]);
    expect(forbiddenIn("const method = `PATCH`;")).not.toEqual([]);
    expect(
      forbiddenIn('"https://gmail.googleapis.com/gmail/v1/users/me/messages/send"'),
    ).not.toEqual([]);
  });

  it("ignores what a comment says the writer must never do", () => {
    expect(forbiddenIn("// never send, trash or delete\nconst x = 1;")).toEqual([]);
    expect(forbiddenIn('const url = base + "/send"; // fine?')).not.toEqual([]);
  });

  it("checks each of the writer's files", () => {
    expect(sources.sort()).toEqual(["access.ts", "names.ts", "writer.ts"]);
  });
});
