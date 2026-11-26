import { RECRUITER_EMAIL_LIMIT } from "./route.js";
import type { RecruiterFacts, RedFlag } from "./schema.js";

// The provenance check for recruiter facts (REC-001, ADR-0004, NS-167): plain code, no model.
// Every value the model read must be stated in the email: a value that isn't is dropped to null
// and counted, never kept. Pay must be an amount written with its currency, and its period must
// be written too. Code also finds the plain red flags itself, so a scam is caught even when the
// model misses it. What the check can't do: tell whether the email's own statements are true.

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

// One amount: "150,000" (commas only in groups of three), "150000", "150k", "95.50".
const AMOUNT = String.raw`((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(k)?`;
const SIGN = String.raw`(us\$|c\$|ca\$|\$|£|€)`;
const CODE = String.raw`(usd|cad|gbp|eur)`;
const RANGE = String.raw`\s*(?:-|–|—|to)\s*`;
// A signed amount or range ("$150k - $180,000", "$95"), or a range or amount then a code
// ("150,000 - 180,000 USD"). The lookbehind stops a match inside a longer number.
const SIGNED = new RegExp(
  String.raw`${SIGN}\s*${AMOUNT}(?:${RANGE}(?:${SIGN})?\s*${AMOUNT})?(?![\p{L}\d])`,
  "gu",
);
const CODED = new RegExp(
  String.raw`(?<![\d.,\p{L}])${AMOUNT}(?:${RANGE}${AMOUNT})?\s*${CODE}(?![\p{L}])`,
  "gu",
);
const SIGN_CURRENCY: Record<string, string> = {
  us$: "USD",
  $: "USD",
  c$: "CAD",
  ca$: "CAD",
  "£": "GBP",
  "€": "EUR",
};

const toNumber = (digits: string | undefined, k: string | undefined): number | null => {
  if (digits === undefined) return null;
  const n = Number(digits.replace(/,/g, ""));
  // Rounded, so "142.3k" is exactly 142300.
  return Number.isFinite(n) ? (k ? Math.round(n * 1_000) : n) : null;
};

// A range's two ends. "150-180k" writes the k once: it applies to a small first number too.
function rangeEnds(m: RegExpMatchArray, at: number): number[] {
  const firstK = m[at + 1];
  const secondK = m[at + 3];
  const first = toNumber(m[at], firstK ?? (secondK && Number(m[at]) < 1_000 ? secondK : undefined));
  const second = toNumber(m[at + 2], secondK);
  return [first, second].filter((n): n is number => n !== null);
}

// Every amount the email writes with its currency, as "<CURRENCY>:<amount>".
function statedPay(email: string): Set<string> {
  const out = new Set<string>();
  for (const m of email.matchAll(SIGNED)) {
    const currency = SIGN_CURRENCY[m[1] ?? ""];
    // Groups: 1 sign, 2–3 first amount, 4 second sign, 5–6 second amount.
    const ends = rangeEnds([m[0], m[2], m[3], m[5], m[6]] as RegExpMatchArray, 1);
    for (const n of ends) if (currency) out.add(`${currency}:${n}`);
  }
  for (const m of email.matchAll(CODED)) {
    const currency = (m[5] ?? "").toUpperCase();
    for (const n of rangeEnds(m, 1)) out.add(`${currency}:${n}`);
  }
  return out;
}

// What tells a reader each pay period.
const PERIOD_WORDS: Record<"year" | "month" | "hour", RegExp> = {
  year: /\bper (?:year|annum)\b|\ba year\b|\/ ?(?:yr|year)\b|\bannual(?:ly)?\b|\byearly\b|\bp\.a\./,
  month: /\bper month\b|\ba month\b|\/ ?(?:mo|month)\b|\bmonthly\b/,
  hour: /\bper hour\b|\ban hour\b|\/ ?(?:hr|hour)\b|\bhourly\b/,
};

// What tells a reader each way of working.
const REMOTE_WORDS: Record<"onsite" | "hybrid" | "remote", RegExp> = {
  remote: /\bremote(?:ly)?\b/,
  hybrid: /\bhybrid\b/,
  onsite: /\bon[- ]?site\b|\bin[- ]office\b|\bin[- ]person\b/,
};

// Red flags plain code finds by itself: asking for money or for identity and bank details.
const CODE_FLAGS: { kind: RedFlag; pattern: RegExp }[] = [
  { kind: "upfront_fee", pattern: /\bgift cards?\b|\bwire transfer\b|\bwestern union\b/ },
  {
    kind: "upfront_fee",
    pattern: /\b(?:send|pay|wire|transfer)\b[^.!?]{0,40}\b(?:deposit|fee|fees)\b/,
  },
  {
    kind: "sensitive_data",
    pattern:
      /\bbank account\b|\brouting number\b|\bsocial (?:security|insurance)\b|\bssn\b|\bpassport (?:number|copy|scan|details)\b|\bcredit card\b/,
  },
];

export function checkRecruiterFacts(facts: RecruiterFacts, rawEmail: string): RecruiterCheck {
  // The same cut the route uses, so a caller can't hand the regexes an unbounded text.
  const email = squash(rawEmail.slice(0, RECRUITER_EMAIL_LIMIT));
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
  // "Not remote: onsite in Chicago" names both: the way of working is then unclear.
  if (
    facts.remote !== null &&
    (!REMOTE_WORDS[facts.remote].test(email) ||
      (facts.remote === "remote" && REMOTE_WORDS.onsite.test(email)))
  ) {
    drop("remote");
  }

  // Pay counts only as an amount written with this currency ("$180k", "180,000 USD"): a stray
  // number ("200 engineers") or a currency named elsewhere backs nothing.
  const pay = statedPay(email);
  for (const field of ["salaryMin", "salaryMax"] as const) {
    const value = facts[field];
    if (value !== null && !pay.has(`${facts.salaryCurrency}:${value}`)) drop(field);
  }
  if (facts.salaryPeriod !== null && !PERIOD_WORDS[facts.salaryPeriod].test(email)) {
    drop("salaryPeriod");
  }
  // Without an amount, the currency and period say nothing.
  if (out.salaryMin === null && out.salaryMax === null) {
    if (out.salaryCurrency !== null) drop("salaryCurrency");
    if (out.salaryPeriod !== null) drop("salaryPeriod");
  }

  const quoted = (q: string) =>
    squash(q).split(" ").length >= MIN_QUOTE_WORDS && hasWhole(email, q);
  if (facts.personalizedQuote !== null && !quoted(facts.personalizedQuote)) {
    drop("personalizedQuote");
  }
  for (const flag of facts.redFlags) {
    if (quoted(flag.quote)) out.redFlags.push(flag);
    else dropped.push("redFlags");
  }
  // Code's own flags are added, never removed: the model can't talk a scam out of its F.
  for (const { kind, pattern } of CODE_FLAGS) {
    const found = pattern.exec(email);
    if (found && !out.redFlags.some((f) => f.kind === kind)) {
      out.redFlags.push({ kind, quote: found[0] });
    }
  }
  return { facts: out, dropped };
}
