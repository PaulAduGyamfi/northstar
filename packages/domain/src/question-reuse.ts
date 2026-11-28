import { isSafeCompany } from "./company-name.js";
import { isNegatedQuestion, matchQuestion } from "./question-match.js";

// How a reused banked answer counts for the Gate's policy (APPLY-004, NS-249 slice 3), from the
// form's own label: one rule for the producer (packages/pipeline) and the Gate (packages/db), so
// neither can count a reuse the other wouldn't. The label is the employer's text, so only a close
// match may let an answer skip Paul's review:
// - bank_exact: the label is the canonical question's own wording (or one of its examples),
//   company name aside;
// - bank_high_confidence: a match at REUSE_HIGH_CONFIDENCE or above whose every word is known
//   (isKnownWording, NS-277);
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

// How long a company name may be and still earn reuse credit (NS-278). The name and the label both
// come from the employer, and isSafeCompany accepts up to 80 characters of plain words, so a name
// such as "Acme Your Salary Expectations" could carry an ask into a label that reads as exact. A
// longer name still fills an answer's {company} slot (adaptAnswer); it only earns no reuse, so
// those labels go to Paul.
export const REUSE_COMPANY_MAX_WORDS = 3;
export const REUSE_COMPANY_MAX_LENGTH = 40;

// The company name may count toward reuse: a plain short name (isSafeCompany) of at most
// REUSE_COMPANY_MAX_WORDS words and REUSE_COMPANY_MAX_LENGTH characters.
export function isReuseCompany(company: string): boolean {
  if (company === "" || company.length > REUSE_COMPANY_MAX_LENGTH || !isSafeCompany(company)) {
    return false;
  }
  const words = labelWords(company).length;
  return words >= 1 && words <= REUSE_COMPANY_MAX_WORDS;
}

// The label is the canonical question's own wording, or one of its examples, with `{company}`
// filled by the job's company. A wording with the slot counts only for a company isReuseCompany
// accepts: the name and the label both come from the employer, so a "company" such as "Acme? Also
// list your salary" (not plain) or "Acme Your Salary Expectations" (too long) must not make an
// extra ask look exact.
export function isExactWording(
  label: string,
  canonical: { text: string; examples: readonly string[] },
  company: string,
): boolean {
  const safe = isReuseCompany(company);
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
// - any character outside the Latin, Common and Inherited scripts, letter or not: Greek or
//   Cyrillic lookalikes ("nоt" with a Cyrillic о; the Greek tonos U+0384 as an apostrophe), and
//   since NS-273 Armenian "օ", Cherokee and Coptic letters and Hangul fillers. A label in another
//   script is refused whole: conservative, it goes to Paul;
// - private-use and unassigned code points (\p{Co}, \p{Cn}), which an employer's web font may draw
//   as any letter.
// Both the label and its NFKC form are checked, since the matcher reads the NFKC form: the acute
// accent U+00B4 is Common, but NFKC turns it into a space and a combining mark.
// The producer (packages/pipeline) runs the same check, so it never answers one (NS-272, NS-273).
const HIDING = /[\p{Cf}\p{M}\p{Co}\p{Cn}\u0250-\u02FF\u1D00-\u1DBF\u2800]/u;
const OTHER_SCRIPT = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

const hides = (text: string): boolean => HIDING.test(text) || OTHER_SCRIPT.test(text);

export const isDisguisedLabel = (label: string): boolean =>
  hides(label) || hides(label.normalize("NFKC"));

// Words a label may add to the canonical wording without losing high confidence (NS-277, #429):
// politeness and framing. Deliberately small, with no negation ("not", "never", "no") and no modal
// ("would", "could"). It doesn't stop a second ask built only from known words ("…and what
// interests you about Example Corp"): that stays a match of the same question, and limits it.
export const KNOWN_FILLER: ReadonlySet<string> = new Set(
  (
    "a an the and of in on at to for with about is are be do does you your we our us i me my " +
    "this that it what why how please briefly describe tell share explain"
  ).split(" "),
);

// A label's words: NFKC, lowercase, runs of letters, digits and apostrophes, with a trailing "'s"
// (a possessive: "Example Corp's") and stray apostrophes dropped. A split word ("wouldn t",
// "ne ver") reads as its pieces, which no wording lists.
export function labelWords(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\u2018\u2019\u02bc`]/g, "'")
      .match(/[\p{L}\p{N}']+/gu) ?? []
  )
    .map((w) => w.replace(/'s$/, "").replace(/^'+|'+$/g, ""))
    .filter((w) => w !== "");
}

// The label with every whole occurrence of the company's name taken out (NS-278): the name, as one
// unit and in its own order, where the label writes it. Its words earn no credit anywhere else, so
// "Why do you want to work at Acme? Your salary expectations?" with the company "Acme Your Salary
// Expectations" keeps "Acme", "your", "salary" and "expectations" (the name isn't written whole).
// Compared after NFKC and lowercasing, the way labelWords reads both.
function withoutCompany(label: string, company: string): string {
  const text = label.normalize("NFKC").toLowerCase();
  const name = company.normalize("NFKC").toLowerCase().trim();
  if (name === "") return text;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  // Only where no letter or digit touches either end, so "Acme" never eats part of "Acmeless".
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "gu"), " ");
}

// Every word of the label is known (NS-277, #429, option 2): a word of the canonical question's own
// wording or examples, or a KNOWN_FILLER word, once the company's name is taken out where the label
// writes it whole (withoutCompany, NS-278; only a company isReuseCompany accepts). A slot in a
// wording adds no words, and the company's words count nowhere but as the whole name. One unknown
// word (a split "not", a lookalike letter the disguise rule lets through, an extra ask) and the
// label isn't a confident reuse: it goes to Paul.
export function isKnownWording(
  label: string,
  canonical: { text: string; examples: readonly string[] },
  company: string,
): boolean {
  const known = new Set(KNOWN_FILLER);
  for (const w of [canonical.text, ...canonical.examples]) {
    for (const word of labelWords(w.replace(/\{[a-z]+\}/g, " "))) known.add(word);
  }
  const rest = labelWords(isReuseCompany(company) ? withoutCompany(label, company) : label);
  // The label must hold words of its own, not only the company's name.
  return rest.length > 0 && rest.every((w) => known.has(w));
}

// The strength from a match code already made (the producer's path, which also takes a model's
// pick only to fill, never to count as reuse).
export function reuseStrength(
  label: string,
  match: { canonical: { text: string; examples: readonly string[] }; confidence: number },
  company: string,
): ReuseSource {
  if (isExactWording(label, match.canonical, company)) return "bank_exact";
  return match.confidence >= REUSE_HIGH_CONFIDENCE &&
    isKnownWording(label, match.canonical, company)
    ? "bank_high_confidence"
    : "new";
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
