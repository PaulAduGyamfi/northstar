import type { ProfileExtract } from "./schema.js";

// The deterministic provenance check (ADR-0004, NFR-AIQ-002): plain code, no model. An extraction
// may only say what the resume says. A failure names the item and the problem, never its text.
export type ProvenanceFailure = {
  item: "role" | "education" | "atom" | "skill" | "certification" | "link";
  index: number;
  problem: string;
};

export type ProvenanceResult = { ok: true } | { ok: false; failures: ProvenanceFailure[] };

// Typography only: curly quotes, dash variants, non-breaking spaces and line breaks (a bullet that
// wraps). Words, digits and punctuation that carry meaning are compared exactly.
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// Numbers as whole tokens, so "4" is not found inside "40".
export function numbers(text: string): Set<string> {
  return new Set(text.match(/\d+(?:[.,]\d+)*/g) ?? []);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// A date is in the text at the precision it claims. "YYYY": the year as a whole number.
// "YYYY-MM": the year with that month, by name ("Mar 2021", "March, 2021") or by number
// ("03/2021", "3/2021", "2021-03").
function monthInResume(month: string, text: string): boolean {
  const [year, mm] = month.split("-");
  if (year && mm === undefined) return new RegExp(`(?<![0-9])${year}(?![0-9])`).test(text);
  const m = Number(mm);
  const name = MONTHS[m - 1];
  if (!year || !name) return false;
  const patterns = [
    new RegExp(`\\b${name}[a-z]*\\.?,?\\s+${year}\\b`, "i"),
    new RegExp(`\\b0?${m}[/.]${year}\\b`),
    new RegExp(`\\b${year}-${mm}\\b`),
  ];
  return patterns.some((p) => p.test(text));
}

// Whole-word match in already-normalised text: the value may not start or end inside a longer
// word, so an invented "Go" isn't found in "Google" and "C" isn't found in "C#" or "C++".
// Quotes and URLs, being longer, use the same rule harmlessly.
function hasWhole(haystack: string, value: string): boolean {
  const needle = normalize(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = "[\\p{L}\\p{N}+#]";
  return needle !== "" && new RegExp(`(?<!${word})${needle}(?!${word})`, "u").test(haystack);
}

// The text near every occurrence of an anchor (an employer, a school, a certification name):
// where that item's own dates and "Present" are written. 120 characters either side covers a
// header line plus a location or date line. Where bullets separate entries that excludes the
// next role down; compact one-line entries (common for education and certifications) can still
// borrow a neighbour's dates or Present (a known limit, ADR-0004).
const NEAR = 120;
function nearText(text: string, anchor: string): string {
  const needle = normalize(anchor);
  const windows: string[] = [];
  if (needle === "") return "";
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    windows.push(text.slice(Math.max(0, at - NEAR), at + needle.length + NEAR));
  }
  return windows.join(" | ");
}

// "Present" as a date range's end: after a dash (normalize turns every dash into "-") or "to",
// so "now" or "current" in a bullet's prose doesn't make a role current.
const CURRENT = /(?:-|\bto)\s*(present|current|now|date|today|ongoing)\b/i;

export function validateProvenance(extract: ProfileExtract, resumeText: string): ProvenanceResult {
  const text = normalize(resumeText);
  const has = (value: string) => hasWhole(text, value);
  const failures: ProvenanceFailure[] = [];
  const fail = (item: ProvenanceFailure["item"], index: number, problem: string) =>
    failures.push({ item, index, problem });

  // Role keys must be unique, and every atom's role key must exist: otherwise an atom would
  // silently attach to the wrong employer.
  const keys = new Set<string>();
  extract.roles.forEach((role, i) => {
    if (keys.has(role.key)) fail("role", i, "duplicate_role_key");
    keys.add(role.key);
  });

  extract.roles.forEach((role, i) => {
    if (!has(role.title)) fail("role", i, "title_not_in_resume");
    if (!has(role.employer)) {
      // No employer to anchor its dates to; that failure already rejects the extraction.
      fail("role", i, "employer_not_in_resume");
      return;
    }
    // Dates are locked facts: each must be written next to this role's employer, so dates from
    // another role (or an award line) can't be borrowed.
    const near = nearText(text, role.employer);
    const dates = [role.startMonth, role.endMonth].filter((d): d is string => d !== null);
    if (dates.some((d) => !monthInResume(d, near))) fail("role", i, "date_not_in_resume");
    if (role.current && role.endMonth !== null) fail("role", i, "current_with_end_date");
    else if (role.current && !CURRENT.test(near)) fail("role", i, "current_not_in_resume");
  });

  extract.education.forEach((edu, i) => {
    if (!has(edu.school)) fail("education", i, "school_not_in_resume");
    if (edu.degree !== null && !has(edu.degree)) fail("education", i, "degree_not_in_resume");
    if (edu.field !== null && !has(edu.field)) fail("education", i, "field_not_in_resume");
    const near = nearText(text, edu.school);
    for (const month of [edu.startMonth, edu.endMonth]) {
      if (month !== null && !monthInResume(month, near)) fail("education", i, "date_not_in_resume");
    }
  });

  extract.atoms.forEach((atom, i) => {
    if (atom.roleKey !== null && !keys.has(atom.roleKey)) fail("atom", i, "unknown_role_key");
    if (!has(atom.sourceQuote)) {
      fail("atom", i, "quote_not_in_resume");
      return;
    }
    // Every field of the atom rests on its own bullet: the headline (what), impact and scope may
    // only use numbers the bullet states; each stack item and each month must be in the bullet.
    const quote = normalize(atom.sourceQuote);
    const quoteNumbers = numbers(quote);
    const claimed = [atom.what, atom.impact, atom.scope].filter((v): v is string => v !== null);
    if (claimed.some((v) => [...numbers(v)].some((n) => !quoteNumbers.has(n)))) {
      fail("atom", i, "number_not_in_quote");
    }
    if (atom.how.some((tool) => !hasWhole(quote, tool))) fail("atom", i, "how_not_in_quote");
    for (const month of [atom.startMonth, atom.endMonth]) {
      if (month !== null && !monthInResume(month, quote)) fail("atom", i, "date_not_in_quote");
    }
    if (atom.evidenceLink !== null && !has(atom.evidenceLink)) {
      fail("atom", i, "link_not_in_resume");
    }
  });

  extract.skills.forEach((skill, i) => {
    if (!has(skill)) fail("skill", i, "not_in_resume");
  });
  extract.certifications.forEach((cert, i) => {
    if (!has(cert.name) || (cert.issuer !== null && !has(cert.issuer))) {
      fail("certification", i, "not_in_resume");
    } else if (
      cert.issuedMonth !== null &&
      !monthInResume(cert.issuedMonth, nearText(text, cert.name))
    ) {
      fail("certification", i, "date_not_in_resume");
    }
  });
  extract.links.forEach((link, i) => {
    if (!has(link.url)) fail("link", i, "not_in_resume");
  });

  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}
