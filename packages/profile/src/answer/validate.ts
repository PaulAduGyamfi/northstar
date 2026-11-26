import { nameCandidates } from "../names.js";
import { hasWhole, normalize, numbers, quotedIn } from "../validate.js";
import type { EvidenceItem } from "./evidence.js";
import type { AnswerDraft } from "./schema.js";

// The deterministic provenance check for answer drafts (ANS-004, ADR-0004, NS-135): plain code,
// no model. Every sentence must rest on the stories and atoms the route was given. Plain code
// can't tell a claim from framing, so every sentence cites. A failure names the sentence and the
// problem, never the text (it is Paul's own material, or the employer's).
export type AnswerFailure = { sentence: number | null; problem: string };

export type AnswerValidation = { ok: true } | { ok: false; failures: AnswerFailure[] };

// Ordinary sentence openers. A first word not on this list is checked like any other capitalised
// word, so "Globex asked me…" can't slip a name in at the start.
export const STARTERS = new Set(
  (
    "A After Afterwards Again All Also Although An And As At Because Before Both But By During " +
    "Each Earlier Eventually Every Finally First For From However I If In Initially It Last " +
    "Later Many Most My Next Now On Once One Our Over Overall Recently Since So Some That The " +
    "Then There This Three To Together Two Ultimately Until We What When While With Within"
  ).split(" "),
);

export const MIN_QUOTE_WORDS = 2;

// Numbers written as words. Like digits, they must come from the sentence's own quotes, so
// "a team of twenty" can't be slipped in where the evidence says "a team".
export const NUMBER_WORDS = new Set(
  (
    "zero two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen " +
    "sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety " +
    "hundred hundreds thousand thousands million millions billion billions dozen dozens double " +
    "doubled triple tripled twice thrice half percent"
  ).split(" "),
);

// The joined answer as a form would receive it.
export function answerText(draft: AnswerDraft): string {
  return draft.sentences.map((s) => s.text.trim()).join(" ");
}

export function validateAnswerDraft(
  draft: AnswerDraft,
  evidence: readonly EvidenceItem[],
  limit: number | null,
): AnswerValidation {
  const failures: AnswerFailure[] = [];
  // A story's title is shown to the model but is no evidence (NS-202): titles are never
  // name-checked, so quotes and names come from `checkText` (the four parts) when it is set.
  const byId = new Map(evidence.map((e) => [e.id, normalize(e.checkText ?? e.text)]));

  if (draft.sentences.length === 0) failures.push({ sentence: null, problem: "no sentences" });

  draft.sentences.forEach((sentence, index) => {
    const fail = (problem: string) => failures.push({ sentence: index, problem });
    if (sentence.cites.length === 0) {
      fail("cites nothing");
      return;
    }
    const citedTexts: string[] = [];
    sentence.cites.forEach((cite, c) => {
      const itemText = byId.get(cite.id);
      if (itemText === undefined) {
        fail(`cite ${c} names an id not in the evidence`);
        return;
      }
      citedTexts.push(itemText);
      // Whole words and whole numbers only (NS-200): a quote cut from inside a word or a number
      // ("2 engineers" out of "12 engineers", "5 million" out of "1.5 million") would let an
      // invented figure pass the number rule below.
      if (!quotedIn(itemText, normalize(cite.quote))) fail(`cite ${c} quote is not in its item`);
      // A quote must carry meaning: two words at least, so "e" can't make a sentence "cited".
      else if (normalize(cite.quote).split(" ").length < MIN_QUOTE_WORDS) {
        fail(`cite ${c} quote is shorter than ${MIN_QUOTE_WORDS} words`);
      }
    });

    const text = normalize(sentence.text);
    const quotes = sentence.cites.map((c) => normalize(c.quote));
    const quoteText = quotes.join(" \n ").toLowerCase();
    // Numbers come from this sentence's own quotes, so a figure can't move between claims.
    const quoted = new Set(quotes.flatMap((q) => [...numbers(q)]));
    // Names (employers, tools, people, places) come from the items this sentence cites.
    const names = citedTexts.join(" \n ");
    const seen = new Set<string>();
    // Failures give a word's position in the sentence, never the word: it is either Paul's
    // material or text from the employer's question, and failures reach the caller's events.
    text.split(" ").forEach((raw, position) => {
      // Edge punctuation off ("Go." → "Go"), keeping name characters such as + and #.
      const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}+#]+$/gu, "");
      for (const n of numbers(word)) {
        if (!quoted.has(n)) fail(`number at word ${position} is not in its quotes`);
      }
      // A number in words ("twenty", "double") is a number too: it must be in the quotes.
      const lower = word.toLowerCase();
      if (NUMBER_WORDS.has(lower) && !hasWhole(quoteText, lower)) {
        fail(`number at word ${position} is not in its quotes`);
      }
      // The whole word, then each name piece (NS-202: "iOS", "ex-Globex", "3M"; never "I"); one
      // failure per word at most.
      let unbacked = false;
      for (const { name, leading } of nameCandidates(word)) {
        // A sentence's first word is capitalised anyway: an opener, or a word the cited text
        // holds in lower case ("Deadlines slipped…"), isn't a name. Only at the word's start.
        if (
          position === 0 &&
          leading &&
          (STARTERS.has(name) || hasWhole(names, name.toLowerCase()))
        ) {
          continue;
        }
        if (seen.has(name)) continue;
        seen.add(name);
        // Names may come from anywhere in a cited item (a story names its employer once), while
        // numbers must come from the sentence's own quotes (a figure belongs to one claim).
        if (!hasWhole(names, name)) unbacked = true;
      }
      if (unbacked) fail(`name at word ${position} is not in its cited items`);
    });
  });

  if (limit !== null && answerText(draft).length > limit) {
    failures.push({ sentence: null, problem: `longer than the limit of ${limit} characters` });
  }
  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}
