import { isSafeCompany } from "./company-name.js";
import { isNegatedQuestion, matchQuestion } from "./question-match.js";

// How a reused banked answer counts for the Gate's policy (APPLY-004, NS-249 slice 3), from the
// form's own label: one rule for the producer (packages/pipeline) and the Gate (packages/db), so
// neither can count a reuse the other wouldn't. The label is the employer's text, so only a close
// match may let an answer skip Paul's review:
// - bank_exact: the label is the canonical question's own wording (or one of its examples),
//   company name aside;
// - bank_high_confidence: a match at REUSE_HIGH_CONFIDENCE or above;
// - new: a weaker match (the 0.6 matching floor is not "high confidence"). It still fills the
//   field, but Paul reviews it.
export type ReuseSource = "bank_exact" | "bank_high_confidence" | "new";

export const REUSE_HIGH_CONFIDENCE = 0.8;

// Lowercase, single spaces, no trailing punctuation: how two wordings are compared.
const plain = (text: string) =>
  text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[?.!:\s]+$/, "")
    .toLowerCase();

// The label is the canonical question's own wording, or one of its examples, with `{company}`
// filled by the job's company. A wording with the slot counts only for a plain short company name
// (isSafeCompany, as the answer's own fill): the name and the label both come from the employer,
// so a "company" such as "Acme? Also list your salary" must not make an extra ask look exact.
export function isExactWording(
  label: string,
  canonical: { text: string; examples: readonly string[] },
  company: string,
): boolean {
  const safe = company !== "" && isSafeCompany(company);
  return [canonical.text, ...canonical.examples].some(
    (w) =>
      (safe || !w.includes("{company}")) &&
      plain(w.replaceAll("{company}", company)) === plain(label),
  );
}

// Characters a label could use to hide a word from the matcher and the negation check. A label
// holding any of them never earns reuse; it only goes to Paul:
// - invisible formatting (zero-width spaces, direction marks: \p{Cf});
// - combining marks of every kind (\p{M}): an accent ("no\u0301t": NFKC composes it, so "not" no
//   longer reads as a word), an enclosing or spacing mark ("n\u20ddot"), the grapheme joiner
//   U+034F and variation selectors (NS-273). So a label sent decomposed (NFD) goes to Paul too;
// - modifier letters (U+02BC as an apostrophe in "wouldnʼt"), the braille blank U+2800, and the
//   IPA and phonetic letters (U+0250–U+02AF, U+1D00–U+1DBF: "nᴏt" with a small capital O), Latin
//   script but needed by no company name (NS-273);
// - any letter outside the Latin, Common and Inherited scripts: Greek or Cyrillic lookalikes
//   ("nоt" with a Cyrillic о), and since NS-273 Armenian "օ", Cherokee and Coptic letters and
//   Hangul fillers. A label in another script is refused whole: conservative, it goes to Paul.
// The producer (packages/pipeline) runs the same check, so it never answers one (NS-272, NS-273).
const HIDING = /[\p{Cf}\p{M}\u0250-\u02FF\u1D00-\u1DBF\u2800]/u;
const OTHER_SCRIPT = /(?![\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}])\p{L}/u;

export const isDisguisedLabel = (label: string): boolean =>
  HIDING.test(label) || OTHER_SCRIPT.test(label);

// The strength from a match code already made (the producer's path, which also takes a model's
// pick only to fill, never to count as reuse).
export function reuseStrength(
  label: string,
  match: { canonical: { text: string; examples: readonly string[] }; confidence: number },
  company: string,
): ReuseSource {
  if (isExactWording(label, match.canonical, company)) return "bank_exact";
  return match.confidence >= REUSE_HIGH_CONFIDENCE ? "bank_high_confidence" : "new";
}

// The Gate's own reading: what an answer banked for `canonicalId` earns on a field with this label.
// `new` unless code's match of the label is that same canonical question, a narrative one (a factual
// question is answered from settings, never the bank), and the label isn't negated ("Why would you
// NOT…" asks the opposite of the banked question; the matcher drops "not" as filler).
export function labelReuse(label: string, canonicalId: string, company: string): ReuseSource {
  if (isDisguisedLabel(label)) return "new";
  const match = matchQuestion(label);
  if (match.status !== "matched" || match.canonical.id !== canonicalId) return "new";
  if (match.canonical.kind === "factual" || isNegatedQuestion(label)) return "new";
  return reuseStrength(label, match, company);
}

const RANK: Record<ReuseSource, number> = { new: 0, bank_high_confidence: 1, bank_exact: 2 };

// The weaker of two readings: the Gate never counts more reuse than either it or the producer saw.
export const weakerReuse = (a: ReuseSource, b: ReuseSource): ReuseSource =>
  RANK[a] <= RANK[b] ? a : b;
