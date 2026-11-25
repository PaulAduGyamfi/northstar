import { CANONICAL_QUESTIONS, type QuestionKind } from "./question-canon.js";

// Reusing a banked answer (ANS-003, GH-59), as plain code: fill its company slot, fit it to the
// form's length limit, and say how often it was used. It never rewrites or cuts Paul's words:
// anything that doesn't fit as approved goes back to him.

// Any braces count as a slot, so `{Company}` or `{ company }` is caught rather than sent as
// text. `{company}` is the only one the code fills, in one pass: a name that looks like a slot is
// not expanded again.
const SLOT = /\{([^{}]*)\}/g;

// The company name comes from job data (an ATS, a page's JSON-LD, a model's reading of a page),
// and the filled text may go out under Paul's name having been approved only as a template. So
// only a plain short name is filled in: letters, digits, spaces and & ' - , ( ) and a dot only
// inside a word (Inc., Booking.com), no sentence, URL, address or line break.
const MAX_COMPANY_LENGTH = 80;
const SAFE_COMPANY = /^[\p{L}\p{N}][\p{L}\p{N} &'’,()-]*(?:\.[\p{L}\p{N} &'’,()-]+)*\.?$/u;
const LOOKS_LIKE_LINK = /\b(?:https?|www)\b|\.(?:com|net|org|io|co)\b.*\s/i;

function isSafeCompany(name: string): boolean {
  return (
    name.length <= MAX_COMPANY_LENGTH && SAFE_COMPANY.test(name) && !LOOKS_LIKE_LINK.test(name)
  );
}

export type StoredAnswer = { shortText: string; longText: string | null };

export type AdaptedAnswer =
  | { status: "ok"; text: string; variant: "long" | "short" }
  // Neither approved variant fits the limit: Paul shortens it (a new version), never the code.
  | { status: "too_long"; maxLength: number; shortLength: number }
  // A slot the code can't fill: an unknown one, or {company} with no company name.
  | { status: "missing_slot"; slot: string }
  // The company name isn't a plain short name; Paul fills it in himself.
  | { status: "unsafe_company" };

// Picks the long variant when it fits `maxLength` (characters; null for no limit), else the
// short one, with `{company}` filled in.
export function adaptAnswer(
  stored: StoredAnswer,
  opts: { company: string | null; maxLength: number | null },
): AdaptedAnswer {
  const company = opts.company?.trim() ?? "";
  const variants: Array<["long" | "short", string]> =
    stored.longText === null
      ? [["short", stored.shortText]]
      : [
          ["long", stored.longText],
          ["short", stored.shortText],
        ];
  const needsCompany = variants.some(([, t]) => t.includes("{company}"));
  if (needsCompany && company !== "" && !isSafeCompany(company)) {
    return { status: "unsafe_company" };
  }
  let shortLength = 0;
  for (const [variant, template] of variants) {
    for (const [, slot] of template.matchAll(SLOT)) {
      if (slot !== "company" || company === "") return { status: "missing_slot", slot: slot ?? "" };
    }
    const text = template.replace(SLOT, () => company);
    if (variant === "short") shortLength = text.length;
    if (opts.maxLength === null || text.length <= opts.maxLength) {
      return { status: "ok", text, variant };
    }
  }
  return { status: "too_long", maxLength: opts.maxLength ?? 0, shortLength };
}

// What Paul sees next to a reused answer (ANS-003).
export function reuseNote(useCount: number): string {
  return `reused from bank (used ${useCount}×)`;
}

type BankKind = Exclude<QuestionKind, "factual">;
const BANKABLE = new Map<string, BankKind>(
  CANONICAL_QUESTIONS.flatMap((q) => (q.kind === "factual" ? [] : [[q.id, q.kind] as const])),
);

// The kind the bank stores for a canonical question; null for a factual or unknown id, which the
// bank never holds (factual answers come from settings).
export function narrativeKindOf(canonicalId: string): BankKind | null {
  return BANKABLE.get(canonicalId) ?? null;
}
