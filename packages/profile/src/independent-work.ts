import { err, ok, type Result } from "@northstar/domain";

// Gap-to-proof (NS-196, DX-010): Paul's independent work since his last role, as a "Projects /
// Independent work" resume section and a 20-second answer to "what have you been doing since?".
// Plain code, no model. There is no resume line to quote for this work, so its provenance is
// Paul's own file: every title and line shown is his, verbatim, and the answer names its sources.

export type WorkEntry = {
  title: string;
  // YYYY-MM.
  start: string;
  // YYYY-MM, or null while it is ongoing ("present").
  end: string | null;
  // An https link to the work, or null.
  link: string | null;
  // Paul's own lines of proof, 1 to MAX_LINES.
  lines: string[];
};

export type WorkProblem = { line: number; problem: string };

export const MAX_TITLE = 80;
export const MAX_LINE = 200;
export const MAX_LINES = 6;
export const MAX_ENTRIES = 10;
// About 20 seconds spoken, at roughly 150 words a minute with pauses.
export const MAX_ANSWER_WORDS = 55;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
// Control characters (tabs and line breaks included): every field is one plain line.
const CONTROL = /\p{Cc}/u;

// The database stores only links starting with exactly `https://` (case matters) and no control
// characters, so the parser holds the same line: a file that parses always stores.
function httpsLink(raw: string): string | null {
  if (raw.length > 300 || !raw.startsWith("https://") || CONTROL.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
    return raw;
  } catch {
    return null;
  }
}

// One header line: `Title | YYYY-MM | YYYY-MM or present [| https link]`.
function parseHeader(raw: string): Omit<WorkEntry, "lines"> | string {
  const parts = raw.split("|").map((p) => p.trim());
  if (parts.length < 3 || parts.length > 4) {
    return "a header is: Title | YYYY-MM | YYYY-MM or present [| https link]";
  }
  const [title = "", start = "", end = "", link] = parts;
  if (title.length === 0 || title.length > MAX_TITLE || CONTROL.test(title)) {
    return `the title must be 1 to ${MAX_TITLE} characters`;
  }
  if (!MONTH.test(start)) return "the start must be YYYY-MM";
  if (end !== "present" && !MONTH.test(end)) return "the end must be YYYY-MM or present";
  // Same-format months compare as strings.
  if (end !== "present" && end < start) return "the end is before the start";
  const parsedLink = link === undefined ? null : httpsLink(link);
  if (link !== undefined && parsedLink === null) {
    return "the link must be an https link with no user name or password";
  }
  return { title, start, end: end === "present" ? null : end, link: parsedLink };
}

// Reads Paul's file: blocks separated by blank lines, each a header and 1 to MAX_LINES lines
// starting `- `. A file with any problem returns every problem, with its line number, and nothing
// else, so nothing half-read is ever stored.
export function parseIndependentWork(text: string): Result<WorkEntry[], WorkProblem[]> {
  const problems: WorkProblem[] = [];
  const entries: (WorkEntry & { header: number })[] = [];
  let current: (WorkEntry & { header: number }) | null = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      current = null;
      return;
    }
    if (trimmed.startsWith("- ") || trimmed === "-") {
      const body = trimmed.slice(1).trim();
      if (current === null) problems.push({ line, problem: "a line comes before any header" });
      else if (body.length === 0 || body.length > MAX_LINE || CONTROL.test(body)) {
        problems.push({ line, problem: `a line must be 1 to ${MAX_LINE} characters` });
      } else current.lines.push(body);
      return;
    }
    if (current !== null) {
      problems.push({ line, problem: "start each line with '- ', or leave a blank line first" });
      return;
    }
    const header = parseHeader(trimmed);
    if (typeof header === "string") {
      problems.push({ line, problem: header });
      // Its lines still need a home, so they aren't each reported as orphans.
      current = { title: "", start: "", end: null, link: null, lines: [], header: line };
      return;
    }
    current = { ...header, lines: [], header: line };
    entries.push(current);
  });
  for (const e of entries) {
    if (e.lines.length === 0) problems.push({ line: e.header, problem: "an entry needs a line" });
    if (e.lines.length > MAX_LINES) {
      problems.push({ line: e.header, problem: `an entry has at most ${MAX_LINES} lines` });
    }
  }
  if (entries.length === 0 && problems.length === 0) {
    problems.push({ line: 1, problem: "the file has no entries" });
  }
  if (entries.length > MAX_ENTRIES) {
    problems.push({ line: 1, problem: `at most ${MAX_ENTRIES} entries` });
  }
  if (problems.length > 0) return err(problems.sort((a, b) => a.line - b.line));
  return ok(entries.map(({ header: _header, ...e }) => e));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FULL_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// "2026-02" as "Feb 2026" (or "February 2026" for speech).
function monthName(month: string, full = false): string {
  const index = Number(month.slice(5, 7)) - 1;
  return `${(full ? FULL_MONTHS : MONTHS)[index] ?? month.slice(5, 7)} ${month.slice(0, 4)}`;
}

// The entries with their stored positions, ongoing first, then latest end, then latest start.
export function ordered(entries: readonly WorkEntry[]): { entry: WorkEntry; index: number }[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const endA = a.entry.end ?? "9999-99";
      const endB = b.entry.end ?? "9999-99";
      if (endA !== endB) return endA < endB ? 1 : -1;
      if (a.entry.start !== b.entry.start) return a.entry.start < b.entry.start ? 1 : -1;
      return a.index - b.index;
    });
}

export const SECTION_HEADING = "Projects / Independent work";

// The resume section's plain-text lines: the heading, then each entry's title and dates and its
// lines verbatim.
export function independentWorkSection(entries: readonly WorkEntry[]): string[] {
  const out = [SECTION_HEADING];
  for (const { entry } of ordered(entries)) {
    const until = entry.end === null ? "present" : monthName(entry.end);
    out.push(`${entry.title} (${monthName(entry.start)} – ${until})`);
    for (const line of entry.lines) out.push(`- ${line}`);
  }
  return out;
}

// Since when: the official record's latest ended position, or null while one is ongoing (then
// there is no gap to explain) or the record is empty.
export type Since = { employer: string; month: string };

export function sinceFromFacts(
  positions: readonly { employer: string; endDate: string | null; current: boolean }[],
): Since | null {
  if (positions.some((p) => p.current || p.endDate === null)) return null;
  let latest: Since | null = null;
  for (const p of positions) {
    const month = (p.endDate ?? "").slice(0, 7);
    if (latest === null || month > latest.month) latest = { employer: p.employer, month };
  }
  return latest;
}

export type AnswerSource =
  | { part: "since"; employer: string; month: string }
  | { part: "title"; entry: number }
  | { part: "example"; entry: number; line: number };

export type TwentySecondAnswer =
  | { ok: true; text: string; words: number; sources: AnswerSource[] }
  | { ok: false; reason: "no_entries" | "too_long" };

const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;

// "A", "A and B", "A, B and C".
function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

// The spoken answer to "what have you been doing since?": an opener from the official record, the
// entries' titles, and one of Paul's lines as an example, within MAX_ANSWER_WORDS. To fit, it drops
// the later titles, then the example. Only fixed words, his titles and lines, and the record's
// employer and month appear, and `sources` names where each came from.
export function twentySecondAnswer(
  entries: readonly WorkEntry[],
  since: Since | null,
): TwentySecondAnswer {
  const sorted = ordered(entries);
  const first = sorted[0];
  if (first === undefined) return { ok: false, reason: "no_entries" };
  const opener =
    since === null
      ? "Lately I've been working on"
      : `Since leaving ${since.employer} in ${monthName(since.month, true)}, I've been working on`;
  const exampleLine = first.entry.lines[0] ?? "";
  // A spoken sentence ends; Paul's line may not have its own full stop.
  const example = `For example: ${exampleLine}${/[.!?]$/.test(exampleLine) ? "" : "."}`;
  const sinceSource: AnswerSource[] =
    since === null ? [] : [{ part: "since", employer: since.employer, month: since.month }];
  for (const withExample of [true, false]) {
    for (let count = sorted.length; count >= 1; count--) {
      const chosen = sorted.slice(0, count);
      const titles = `${opener} ${list(chosen.map((c) => c.entry.title))}.`;
      const text = withExample ? `${titles} ${example}` : titles;
      const words = wordCount(text);
      if (words > MAX_ANSWER_WORDS) continue;
      const sources: AnswerSource[] = [
        ...sinceSource,
        ...chosen.map((c): AnswerSource => ({ part: "title", entry: c.index })),
        ...(withExample ? [{ part: "example" as const, entry: first.index, line: 0 }] : []),
      ];
      return { ok: true, text, words, sources };
    }
  }
  return { ok: false, reason: "too_long" };
}
