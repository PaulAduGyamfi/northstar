import { MIN_QUOTE_WORDS } from "./answer/validate.js";
import { STAR_PARTS, type StarPart, type StoryDraft } from "./story-schema.js";
import { normalize, numbers } from "./validate.js";

// The deterministic provenance check for stories (ADR-0004, NFR-AIQ-002, NS-111): plain code, no
// model. A story may only say what Paul said in the interview, plus what his resume line states.
// A failure names the part and the problem, never the text (it is Paul's own words).
export type StoryFailure = { item: StarPart | "title" | "atomIds"; problem: string };

export type StoryValidation = { ok: true } | { ok: false; failures: StoryFailure[] };

export type StoryEvidence = {
  atom: { id: string; sourceQuote: string };
  answers: { answer: string }[];
};

export function validateStoryDraft(draft: StoryDraft, evidence: StoryEvidence): StoryValidation {
  const failures: StoryFailure[] = [];
  // Each answer on its own: a quote must sit inside one answer, never stitched across two.
  const answers = evidence.answers.map((a) => normalize(a.answer)).filter((a) => a !== "");
  const atomNumbers = numbers(normalize(evidence.atom.sourceQuote));

  for (const part of STAR_PARTS) {
    const { text, quotes } = draft[part];
    if (quotes.length === 0) failures.push({ item: part, problem: "no quote" });
    quotes.forEach((quote, i) => {
      const q = normalize(quote);
      // Whole words and whole numbers only (NS-184): a quote cut from inside a word or number
      // ("2% to 3%" out of "12% to 3%") would otherwise back a number Paul never said.
      if (q === "" || !answers.some((a) => quotedIn(a, q))) {
        failures.push({ item: part, problem: `quote ${i} is not in the answers` });
      } else if (q.split(" ").length < MIN_QUOTE_WORDS) {
        // Two words at least, as for answers: a single word can't make a part "quoted".
        failures.push({
          item: part,
          problem: `quote ${i} is shorter than ${MIN_QUOTE_WORDS} words`,
        });
      }
    });
    // A part's numbers must come from its own quotes or the resume line, so a figure Paul gave
    // about one thing can't be moved onto another part of the story.
    const allowed = new Set([...atomNumbers, ...quotes.flatMap((q) => [...numbers(normalize(q))])]);
    for (const n of numbers(normalize(text))) {
      if (!allowed.has(n)) {
        failures.push({ item: part, problem: `number ${n} is not in its quotes or the atom` });
      }
    }
  }

  const anyNumbers = new Set([...atomNumbers, ...answers.flatMap((a) => [...numbers(a)])]);
  for (const n of numbers(normalize(draft.title))) {
    if (!anyNumbers.has(n)) {
      failures.push({ item: "title", problem: `number ${n} is not in the answers or the atom` });
    }
  }

  draft.atomIds.forEach((id, i) => {
    if (id !== evidence.atom.id) {
      failures.push({ item: "atomIds", problem: `atom ${i} is not the interview's atom` });
    }
  });
  if (!draft.atomIds.includes(evidence.atom.id)) {
    failures.push({ item: "atomIds", problem: "the interview's atom is not cited" });
  }

  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}

// Whether `quote` sits in `answer` (both normalised) as whole words and whole numbers: it may not
// start or end inside a word, inside a number written with a decimal point or a thousands
// separator ("5 million" out of "1.5 million", "200 users" out of "1,200 users"), or just after a
// minus sign ("5%" out of "-5%"). Story-local on purpose: `hasWhole` is shared by other checks.
export function quotedIn(answer: string, quote: string): boolean {
  const needle = quote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (needle === "") return false;
  const word = "[\\p{L}\\p{N}+#]";
  // A leading digit may not continue "1." / "1," or a minus sign; a trailing one may not run on
  // into ".5" / ",200".
  const before = `(?<!${word})(?<!\\d[.,])${/^\d/.test(quote) ? "(?<!-)" : ""}`;
  const after = `(?!${word})(?![.,]\\d)`;
  return new RegExp(`${before}${needle}${after}`, "u").test(answer);
}
