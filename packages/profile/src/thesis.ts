import { hasWhole, normalize, numbers } from "./validate.js";

// The positioning thesis check (DX-009, ADR-0004, NS-127): plain code that refuses a one-line
// thesis claiming anything Paul's profile doesn't back. It checks digits and names, the same
// heuristics as the resume check; plain-word claims ("doubled") are left to Paul's approval.

export const THESIS_MAX_LENGTH = 200;

export type ThesisRole = {
  employer: string;
  title: string;
  // `YYYY` or `YYYY-MM` (locked facts); null when the resume gives none.
  startMonth: string | null;
  endMonth: string | null;
  current: boolean;
};

export type ThesisEvidence = {
  // The cited atoms' resume lines, verbatim.
  quotes: string[];
  roles: ThesisRole[];
  skills: string[];
  // `YYYY-MM`: the month a current role counts up to.
  asOf: string;
};

export type ThesisFailure =
  | { kind: "no_citation" }
  | { kind: "not_one_sentence" }
  | { kind: "unbacked_number"; token: string }
  | { kind: "unbacked_name"; token: string };

// Months since year 0 for `YYYY` (January) or `YYYY-MM`.
function monthIndex(value: string): number | null {
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(value);
  if (!m) return null;
  return Number(m[1]) * 12 + (m[2] ? Number(m[2]) - 1 : 0);
}

// Whole years the roles cover, overlaps counted once. A role with no start date counts nothing.
export function yearsOfExperience(roles: ThesisRole[], asOf: string): number {
  const now = monthIndex(asOf) ?? 0;
  const spans = roles
    .map((r) => {
      const start = r.startMonth === null ? null : monthIndex(r.startMonth);
      // A year-only end date counts to December of that year.
      const end = r.current
        ? now
        : r.endMonth === null
          ? null
          : (monthIndex(r.endMonth) ?? 0) + (r.endMonth.length === 4 ? 11 : 0);
      return start === null || end === null || end < start ? null : [start, end + 1];
    })
    .filter((s): s is number[] => s !== null)
    .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
  let months = 0;
  let reach = Number.NEGATIVE_INFINITY;
  for (const [start = 0, end = 0] of spans) {
    const from = Math.max(start, reach);
    if (end > from) months += end - from;
    reach = Math.max(reach, end);
  }
  return Math.floor(months / 12);
}

// One sentence: no line break, and no sentence end followed by more text.
function isOneSentence(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= THESIS_MAX_LENGTH && !/\n/.test(t) && !/[.!?]\s+\S/.test(t);
}

// Checks a thesis Paul is about to approve, citing `citedAtoms` atoms. Empty means it passes.
export function checkThesis(
  text: string,
  evidence: ThesisEvidence,
  citedAtoms: number,
): ThesisFailure[] {
  const failures: ThesisFailure[] = [];
  if (citedAtoms < 1) failures.push({ kind: "no_citation" });
  if (!isOneSentence(text)) {
    failures.push({ kind: "not_one_sentence" });
    return failures;
  }
  const thesis = normalize(text);
  const quoted = new Set(evidence.quotes.flatMap((q) => [...numbers(normalize(q))]));
  const years = yearsOfExperience(evidence.roles, evidence.asOf);
  for (const n of numbers(thesis)) {
    if (quoted.has(n)) continue;
    // "N years" / "N+ years" is backed by the roles' locked dates instead.
    const yearsClaim = new RegExp(`(?<![\\d.,])${n}\\+?\\s*(?:years?|yrs?)\\b`, "i");
    if (yearsClaim.test(thesis) && Number(n) <= years) continue;
    failures.push({ kind: "unbacked_number", token: n });
  }
  const names = normalize(
    [
      ...evidence.quotes,
      ...evidence.roles.flatMap((r) => [r.employer, r.title]),
      ...evidence.skills,
    ].join(" \n "),
  );
  const words = thesis.split(" ").slice(1);
  const seen = new Set<string>();
  for (const raw of words) {
    // Edge punctuation off ("Python." → "Python"), keeping name characters such as + and #.
    const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}+#]+$/gu, "");
    if (!/^\p{Lu}/u.test(word) || seen.has(word)) continue;
    seen.add(word);
    if (!hasWhole(names, word)) failures.push({ kind: "unbacked_name", token: word });
  }
  return failures;
}
