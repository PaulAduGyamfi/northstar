import type { RecruiterFacts } from "./schema.js";

// The provenance check for recruiter facts (REC-001, ADR-0004, NS-167): plain code, no model.
// Every value the model read must be in the email. A value that isn't is dropped to null and
// counted, never kept, so the grader only ever sees what the recruiter wrote.

export type RecruiterCheck = {
  facts: RecruiterFacts;
  // The fields dropped, by name (never their values: they would be email text).
  dropped: string[];
};

// A quote must carry meaning, so a word or two can't count as "written for Paul".
export const MIN_QUOTE_WORDS = 4;

const squash = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

// The value as whole words in the email: "Lead" isn't found in "Leadership".
function hasWhole(email: string, value: string): boolean {
  const needle = squash(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (needle === "") return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${needle}(?![\\p{L}\\p{N}])`, "u").test(email);
}

// Every number the email states: plain ("150,000", "150000") and shorthand ("150k").
function statedNumbers(email: string): Set<number> {
  const out = new Set<number>();
  for (const m of email.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(k)?(?![\p{L}\d])/gu)) {
    const n = Number((m[1] ?? "").replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    out.add(m[2] ? n * 1_000 : n);
  }
  return out;
}

// What tells a reader each currency: its code, or its symbol.
const CURRENCY_SIGNS: Record<string, readonly string[]> = {
  USD: ["usd", "$"],
  CAD: ["cad", "c$"],
  GBP: ["gbp", "£"],
  EUR: ["eur", "€"],
};

// What tells a reader each way of working.
const REMOTE_WORDS: Record<"onsite" | "hybrid" | "remote", RegExp> = {
  remote: /\bremote\b/,
  hybrid: /\bhybrid\b/,
  onsite: /\bon-?site\b|\bin[- ]office\b|\bin person\b|\bin-person\b/,
};

export function checkRecruiterFacts(facts: RecruiterFacts, rawEmail: string): RecruiterCheck {
  const email = squash(rawEmail);
  const dropped: string[] = [];
  const out: RecruiterFacts = { ...facts, redFlags: [] };
  const drop = <K extends keyof RecruiterFacts>(field: K) => {
    (out as Record<K, unknown>)[field] = null;
    dropped.push(field);
  };

  for (const field of ["roleTitle", "seniority", "company", "location"] as const) {
    const value = facts[field];
    if (value !== null && !hasWhole(email, value)) drop(field);
  }
  if (facts.remote !== null && !REMOTE_WORDS[facts.remote].test(email)) drop("remote");

  const numbers = statedNumbers(rawEmail.normalize("NFKC").toLowerCase());
  for (const field of ["salaryMin", "salaryMax"] as const) {
    const value = facts[field];
    if (value !== null && !numbers.has(value)) drop(field);
  }
  if (facts.salaryCurrency !== null) {
    const signs = CURRENCY_SIGNS[facts.salaryCurrency] ?? [facts.salaryCurrency.toLowerCase()];
    if (!signs.some((s) => email.includes(s))) drop("salaryCurrency");
  }
  // Without an amount, the currency and period say nothing.
  if (out.salaryMin === null && out.salaryMax === null) {
    if (out.salaryCurrency !== null) drop("salaryCurrency");
    if (out.salaryPeriod !== null) drop("salaryPeriod");
  }

  const quoted = (q: string) =>
    squash(q).split(" ").length >= MIN_QUOTE_WORDS && email.includes(squash(q));
  if (facts.personalizedQuote !== null && !quoted(facts.personalizedQuote)) {
    drop("personalizedQuote");
  }
  for (const flag of facts.redFlags) {
    if (quoted(flag.quote)) out.redFlags.push(flag);
    else dropped.push("redFlags");
  }
  return { facts: out, dropped };
}
