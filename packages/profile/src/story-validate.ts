import { MIN_QUOTE_WORDS, NUMBER_WORDS, STARTERS } from "./answer/validate.js";
import { nameCandidates } from "./names.js";
import { STAR_PARTS, type StarPart, type StoryDraft } from "./story-schema.js";
import { hasWhole, normalize, numbers, quotedIn } from "./validate.js";

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
  // Where a story's names may come from: anything Paul said, or the resume line (NS-200).
  const atomText = normalize(evidence.atom.sourceQuote);
  const sources = [...answers, atomText].join(" \n ");

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
    const ownQuotes = quotes.map((q) => normalize(q)).join(" \n ");
    // Numbers in words ("a team of twenty") follow the same rule as digits.
    for (const position of unbackedNumberWords(normalize(text), `${ownQuotes} \n ${atomText}`)) {
      failures.push({
        item: part,
        problem: `number word at word ${position} is not in its quotes or the atom`,
      });
    }
    for (const position of unbackedNames(normalize(text), sources, ownQuotes)) {
      failures.push({
        item: part,
        problem: `name at word ${position} is not in the answers or the atom`,
      });
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

// Positions of number words ("twenty", "double", "half") in `text` that `sources` doesn't hold.
export function unbackedNumberWords(text: string, sources: string): number[] {
  const lower = sources.toLowerCase();
  const out: number[] = [];
  text.split(" ").forEach((raw, position) => {
    const word = raw.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "").toLowerCase();
    if (NUMBER_WORDS.has(word) && !hasWhole(lower, word)) out.push(position);
  });
  return out;
}

// Positions of capitalised words in `text` (normalised) that `sources` doesn't hold as whole
// words: employers, tools, people or places the story would add. "I" and its contractions are
// Paul, and a possessive "'s" is dropped ("Example Freight's"). A sentence's first word is
// capitalised anyway, so it passes when it is an ordinary opener or the part's own quotes
// (`openers`) hold it in lower case ("Deadlines slipped…"). Only the quotes, not all answers: an
// employer that is also a common word ("Target") can't pass as an opener because Paul once said
// "hit the target". Matching is case-sensitive for the same reason. Positions, never words: the
// text is Paul's own material.
export function unbackedNames(text: string, sources: string, openers: string): number[] {
  const out: number[] = [];
  const seen = new Set<string>();
  let sentenceStart = true;
  text.split(" ").forEach((raw, position) => {
    const first = sentenceStart;
    // The next word starts a sentence when this one ends one.
    sentenceStart = /[.!?]["')\]]*$/.test(raw);
    // Edge punctuation and a possessive off ("Go." → "Go", "Globex's" → "Globex"), keeping name
    // characters such as + and #.
    const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}+#]+$/gu, "").replace(/'s$/u, "");
    // The whole word, then each name piece (NS-202: "iOS", "ex-Globex", "3M"); one failure per
    // word at most.
    let unbacked = false;
    for (const { name, leading } of nameCandidates(word)) {
      // Only the start of a sentence's first word is capitalised by grammar: an ordinary opener
      // or a word the part's own quotes hold in lower case passes there.
      if (first && leading && (STARTERS.has(name) || hasWhole(openers, name.toLowerCase()))) {
        continue;
      }
      if (seen.has(name)) continue;
      seen.add(name);
      if (!hasWhole(sources, name)) unbacked = true;
    }
    if (unbacked) out.push(position);
  });
  return out;
}
