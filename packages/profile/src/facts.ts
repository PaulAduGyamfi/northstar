import type { OfficialPosition } from "@northstar/db";
import { err, ok, type Result } from "@northstar/domain";

// Employment-facts consistency (DX-011): every place that states Paul's employers, titles and
// dates is checked against his official HR record. Plain code decides; no model is involved.

// Where a claim comes from. Only the resume is wired up today (NS-112); LinkedIn, the site and
// application forms (NS-120's Apply Gateway) pass their claims through the same check.
export type ClaimSource = "resume" | "linkedin" | "site" | "application_form";

// One stated position. Dates keep the precision the place gives ("YYYY", "YYYY-MM" or
// "YYYY-MM-DD"); null means it doesn't state one.
export type Claim = {
  source: ClaimSource;
  employer: string;
  title: string;
  start: string | null;
  end: string | null;
  current: boolean;
};

export type MismatchField = "employer" | "title" | "start" | "end" | "current";

// What disagrees, with the claimed position named as the place states it, and both values.
export type Mismatch = {
  source: ClaimSource;
  employer: string;
  title: string;
  field: MismatchField;
  official: string | null;
  claimed: string | null;
};

// Lower case, accents dropped, punctuation as spaces, single spaces. Letters of any script count,
// so a name written in, say, Cyrillic keeps its letters instead of becoming an empty string that
// would match every other such name.
const words = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

// "Globex, Inc." and "Globex" are the same employer: a trailing legal suffix isn't a different name.
const SUFFIXES = new Set(["inc", "incorporated", "llc", "ltd", "corp", "corporation", "co", "plc"]);
function employerKey(s: string): string {
  const w = words(s);
  while (w.length > 1 && SUFFIXES.has(w.at(-1) ?? "")) w.pop();
  return w.join(" ");
}

// "Sr. Engineer" and "Senior Engineer" are the same title; any other difference is a mismatch.
const ABBREVIATIONS: Record<string, string> = { sr: "senior", jr: "junior", mgr: "manager" };
const titleKey = (s: string) =>
  words(s)
    .map((w) => ABBREVIATIONS[w] ?? w)
    .join(" ");

// Two dates agree when they're equal at the precision both have: "2021" and "2021-03" agree with
// "2021-03-01". A less precise date isn't a contradiction; a different one is.
function sameDate(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length);
  return a.slice(0, n) === b.slice(0, n);
}

// Every disagreement between the claims and the official record. A claim that leaves a date out
// isn't a mismatch; a claim the record can't place (employer or title) is.
export function checkEmploymentFacts(official: OfficialPosition[], claims: Claim[]): Mismatch[] {
  const out: Mismatch[] = [];
  for (const c of claims) {
    const at = (field: MismatchField, o: string | null, claimed: string | null) =>
      out.push({
        source: c.source,
        employer: c.employer,
        title: c.title,
        field,
        official: o,
        claimed,
      });
    const key = employerKey(c.employer);
    // A name with no letters or digits at all can't be matched, so it never matches anything.
    const sameEmployer = key === "" ? [] : official.filter((p) => employerKey(p.employer) === key);
    if (sameEmployer.length === 0) {
      at("employer", null, c.employer);
      continue;
    }
    const sameTitle = sameEmployer.filter((q) => titleKey(q.title) === titleKey(c.title));
    // A rehire has two rows with the same employer and title: compare against the stint whose
    // start agrees with the claim, so a correct claim about the second stint isn't flagged.
    const p =
      sameTitle.find((q) => c.start === null || sameDate(c.start, q.startDate)) ?? sameTitle[0];
    if (!p) {
      // Name the titles the record does have, so Paul sees what the claim should say.
      at("title", [...new Set(sameEmployer.map((q) => q.title))].join(" / "), c.title);
      continue;
    }
    if (c.start !== null && !sameDate(c.start, p.startDate)) at("start", p.startDate, c.start);
    // `current` covers both directions: one side says ongoing, the other says it ended.
    if (c.current && !p.current) at("current", `ended ${p.endDate}`, "present");
    else if (!c.current && p.current && c.end !== null) at("current", "present", `ended ${c.end}`);
    else if (!c.current && p.endDate !== null && c.end !== null && !sameDate(c.end, p.endDate)) {
      at("end", p.endDate, c.end);
    }
  }
  return out;
}

// DX-011: a date on an application form that disagrees with the official record must never be
// submitted automatically. The Apply Gateway (NS-120) checks this and raises needs_human.
export const blocksAutoSubmit = (mismatches: Mismatch[]): boolean =>
  mismatches.some((m) => m.source === "application_form");

export type RecordLineError = { line: number; problem: string };

const DATE = /^[0-9]{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12][0-9]|3[01]))?$/;

// Paul's official record file: one position per line, "Employer | Title | start | end", with end
// "present" for an ongoing position. Blank lines and lines starting with # are skipped. Any bad
// line refuses the whole file, so a half-read record is never stored. Errors name the line number
// and the problem, never the line's text.
export function parseOfficialRecord(text: string): Result<OfficialPosition[], RecordLineError[]> {
  const positions: OfficialPosition[] = [];
  const errors: RecordLineError[] = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const problem = (p: string) => errors.push({ line: i + 1, problem: p });
    const parts = line.split("|").map((s) => s.trim());
    const [employer, title, start, end] = parts;
    if (
      parts.length !== 4 ||
      employer === undefined ||
      title === undefined ||
      start === undefined ||
      end === undefined
    ) {
      problem("expected 4 fields: employer | title | start | end");
      continue;
    }
    if (employer === "" || title === "") {
      problem("employer and title can't be empty");
      continue;
    }
    if (!DATE.test(start)) {
      problem("start must be YYYY-MM or YYYY-MM-DD");
      continue;
    }
    const current = end.toLowerCase() === "present";
    if (!current && !DATE.test(end)) {
      problem("end must be YYYY-MM, YYYY-MM-DD or present");
      continue;
    }
    // Same-length prefixes of ISO dates compare correctly as strings.
    const n = Math.min(start.length, end.length);
    if (!current && end.slice(0, n) < start.slice(0, n)) {
      problem("end is before start");
      continue;
    }
    positions.push({ employer, title, startDate: start, endDate: current ? null : end, current });
  }
  if (errors.length > 0) return err(errors);
  if (positions.length === 0) return err([{ line: 0, problem: "no positions in the file" }]);
  return ok(positions);
}
