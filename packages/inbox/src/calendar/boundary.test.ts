import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ADR-0026: the Calendar client reads events on the primary calendar and nothing else. This text
// scan of src/calendar/ is a tripwire next to the client's fixed URL and `fields=`: any write
// method, any other Calendar endpoint or calendar, or a request for the description or location
// fails it.
const FORBIDDEN = [
  // Any quote style, a template or a bare word: only GET is ever sent.
  /\b(POST|PUT|PATCH|DELETE)\b/,
  /\/calendarList\b/,
  /\/acl\b/,
  /\/settings\b/,
  /\bfreeBusy\b/i,
  /\/watch\b/,
  /\/quickAdd\b/,
  /\/import\b/,
  /\/move\b/,
  /\/instances\b/,
  /\/channels\b/,
  // A calendar other than the primary one, by id in the path.
  /\/calendars\/(?!primary\/events\b)/,
  // Fields ADR-0026 says are never fetched.
  /\b(description|location|conferenceData|hangoutLink|attachments)\(/,
  /[,(](description|location|conferenceData|hangoutLink|attachments)[,)]/,
];

// Comments are left out: the client's comments say what it must never do.
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

function forbiddenIn(source: string): string[] {
  const text = code(source);
  return FORBIDDEN.filter((p) => p.test(text)).map(String);
}

const dir = fileURLToPath(new URL(".", import.meta.url));
// Recursive: a file in a sub-folder is scanned too.
const sources = (readdirSync(dir, { recursive: true }) as string[]).filter(
  (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
);

describe("the Calendar client's boundary", () => {
  it.each(sources)("%s reads only the primary calendar's events, with no extra fields", (file) => {
    expect(forbiddenIn(readFileSync(`${dir}/${file}`, "utf8"))).toEqual([]);
  });

  it("catches a forbidden call if one is added", () => {
    expect(forbiddenIn('fetch(url, { method: "POST" })')).not.toEqual([]);
    expect(forbiddenIn("const m = `DELETE`;")).not.toEqual([]);
    expect(
      forbiddenIn('"https://www.googleapis.com/calendar/v3/users/me/calendarList"'),
    ).not.toEqual([]);
    expect(
      forbiddenIn('"https://www.googleapis.com/calendar/v3/calendars/work@example.com/events"'),
    ).not.toEqual([]);
    expect(forbiddenIn('"items(id,summary,description)"')).not.toEqual([]);
    expect(forbiddenIn('"https://www.googleapis.com/calendar/v3/freeBusy"')).not.toEqual([]);
  });

  it("allows the primary calendar's events endpoint", () => {
    expect(
      forbiddenIn('"https://www.googleapis.com/calendar/v3/calendars/primary/events"'),
    ).toEqual([]);
  });

  it("ignores what a comment says the client must never do", () => {
    expect(forbiddenIn("// never POST or read the description\nconst x = 1;")).toEqual([]);
  });

  it("checks each of the client's files", () => {
    expect(sources.sort()).toEqual(["access.ts", "client.ts"]);
  });
});
