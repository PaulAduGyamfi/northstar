import type { CanonicalQuestion, FactualField } from "./question-canon.js";
import { classifyQuestion } from "./question-match.js";

// Factual questions answered from Paul's profile settings (NS-141, ANS-001). Plain code, no
// model: a setting is a typed value Paul stored; the answer is that value in the question's own
// form, or a reason it can't be answered. Nothing is ever defaulted or guessed.

// Fields answered "Yes" or "No".
const YES_NO_FIELDS: ReadonlySet<FactualField> = new Set([
  "work_authorization",
  "needs_sponsorship",
  "willing_to_relocate",
  "previously_employed",
]);
// Fields keyed by what the question names (a country, a skill, a company): one value for all
// would be invented for most of them. Matches QUALIFIED_SETTING_FIELDS in packages/db.
export const QUALIFIED_FIELDS: ReadonlySet<FactualField> = new Set([
  "work_authorization",
  "years_of_experience",
  "previously_employed",
]);
const URL_FIELDS: ReadonlySet<FactualField> = new Set(["linkedin_url", "portfolio_url"]);
const ARRANGEMENTS = ["remote", "hybrid", "onsite"] as const;
const MAX_YEARS = 60;
const MAX_TEXT = 200;
const MAX_QUALIFIER = 100;

export type SettingValueError =
  | "not_yes_no"
  | "not_whole_years"
  | "not_iso_date"
  | "not_arrangement"
  | "not_https_url"
  | "bad_text";

// Checks and normalizes a value Paul types for a field: "Y" becomes "yes", "on-site" "onsite".
export function parseSettingValue(
  field: FactualField,
  raw: string,
): { ok: true; value: string } | { ok: false; error: SettingValueError } {
  const text = raw.trim();
  const lower = text.toLowerCase();
  if (YES_NO_FIELDS.has(field)) {
    if (["yes", "y", "true"].includes(lower)) return { ok: true, value: "yes" };
    if (["no", "n", "false"].includes(lower)) return { ok: true, value: "no" };
    return { ok: false, error: "not_yes_no" };
  }
  if (field === "years_of_experience") {
    // Whole years only: "5", never "5+" or "about 5", so the answer is exactly what Paul said.
    if (!/^\d{1,2}$/.test(text) || Number(text) > MAX_YEARS)
      return { ok: false, error: "not_whole_years" };
    return { ok: true, value: String(Number(text)) };
  }
  if (field === "earliest_start_date") {
    if (!validIsoDate(text)) return { ok: false, error: "not_iso_date" };
    return { ok: true, value: text };
  }
  if (field === "work_arrangement") {
    const value = lower.replace(/[\s-]/g, "");
    if (!(ARRANGEMENTS as readonly string[]).includes(value))
      return { ok: false, error: "not_arrangement" };
    return { ok: true, value };
  }
  if (URL_FIELDS.has(field)) {
    if (!httpsUrl(text)) return { ok: false, error: "not_https_url" };
    return { ok: true, value: text };
  }
  // No control characters (CR, LF, escapes): the value goes on forms and screens as it is.
  if (text.length < 1 || text.length > MAX_TEXT || /\p{Cc}/u.test(text))
    return { ok: false, error: "bad_text" };
  return { ok: true, value: text };
}

// A qualifier (a skill, a country, a company): one line, short, never empty.
export function parseQualifier(raw: string): string | null {
  const text = raw.trim();
  return text.length >= 1 && text.length <= MAX_QUALIFIER && !/\p{Cc}/u.test(text) ? text : null;
}

// YYYY-MM-DD that names a real day (no 2027-02-30).
function validIsoDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

// An https URL with a host and no user name or password in it.
function httpsUrl(text: string): boolean {
  if (/\s/.test(text)) return false;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.hostname.length > 0 && !url.username && !url.password;
  } catch {
    return false;
  }
}

export type Setting = { field: string; qualifier: string; value: string };

export type FactualAnswer =
  | {
      status: "answered";
      answer: string;
      canonical: { id: string; text: string };
      setting: Setting;
      confidence: number;
      // Always true until a labelled set shows the matcher is reliable: Paul checks each one.
      needsReview: true;
    }
  | {
      status: "unanswered";
      reason: "not_factual" | "no_setting" | "no_qualifier" | "form_mismatch";
      canonical: { id: string; text: string } | null;
    };

// Words a yes/no question starts with ("Are you…", "Do you…", "Have you…").
const YES_NO_START =
  /^(are|is|do|does|did|will|would|have|has|had|can|could|should|shall|may|were|was)\b/i;
// A choice between named options ("remote, hybrid or on-site") is not a yes/no question.
const CHOICE = /\bor\b/i;

// Whole-word, case-insensitive: "Go" is in "with Go?" but not in "Google", "C" not in "C++".
function names(question: string, qualifier: string): boolean {
  const escaped = qualifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}+#])`, "iu").test(question);
}

const ARRANGEMENT_LABEL: Record<string, string> = {
  remote: "Remote",
  hybrid: "Hybrid",
  onsite: "On-site",
};

// The value in the question's own form, or null when the form doesn't fit the field.
function render(field: FactualField, question: string, value: string): string | null {
  const text = question.trim();
  const startsYesNo = YES_NO_START.test(text);
  if (YES_NO_FIELDS.has(field)) {
    // "Will you now or in the future require sponsorship?" is still yes/no for a yes/no field.
    if (!startsYesNo) return null;
    return value === "yes" ? "Yes" : "No";
  }
  // "Do you have 5+ years of Go?" or "Are you comfortable on-site?" asks yes/no of a value Paul
  // stored as a number or a word: answering would mean deciding for him.
  if (startsYesNo && !CHOICE.test(text)) return null;
  if (field === "work_arrangement") return ARRANGEMENT_LABEL[value] ?? null;
  return value;
}

// Answers a form question from Paul's settings, or says why it can't.
export function answerFactual(question: string, settings: readonly Setting[]): FactualAnswer {
  const { kind, factualField, match } = classifyQuestion(question);
  if (kind !== "factual" || factualField === null || match.status !== "matched")
    return { status: "unanswered", reason: "not_factual", canonical: null };
  const canonical = canonicalOf(match.canonical);
  const forField = settings.filter((s) => s.field === factualField);
  if (forField.length === 0) return { status: "unanswered", reason: "no_setting", canonical };
  let setting: Setting | undefined;
  if (QUALIFIED_FIELDS.has(factualField)) {
    const named = forField.filter((s) => s.qualifier.length > 0 && names(question, s.qualifier));
    // No stored qualifier named, or two different ones ("Go and Rust"): never pick one.
    const distinct = new Set(named.map((s) => s.qualifier.toLowerCase()));
    if (distinct.size !== 1) return { status: "unanswered", reason: "no_qualifier", canonical };
    setting = named[named.length - 1];
  } else {
    setting = forField[forField.length - 1];
  }
  if (!setting) return { status: "unanswered", reason: "no_setting", canonical };
  const answer = render(factualField, question, setting.value);
  if (answer === null) return { status: "unanswered", reason: "form_mismatch", canonical };
  return {
    status: "answered",
    answer,
    canonical,
    setting,
    confidence: match.confidence,
    needsReview: true,
  };
}

const canonicalOf = (q: CanonicalQuestion) => ({ id: q.id, text: q.text });
