import {
  CANONICAL_QUESTIONS,
  type CanonicalQuestion,
  type FactualField,
  type QuestionKind,
} from "./question-canon.js";
import { normalize } from "./text-normalize.js";

// Plain code, no model (AGENTS.md: code decides). A form question is untrusted text: it is only
// split into words and compared here, never stored, logged or sent anywhere.

// At or above this Dice score a question maps to a canonical question (ANS-002); below it, new.
export const MATCH_THRESHOLD = 0.6;
// When another canonical question scores within this margin of the best one, the match is
// ambiguous and the question is treated as new rather than guessed.
export const AMBIGUITY_MARGIN = 0.1;
// Factual answers are filled in from settings without drafting, so a wrong factual match costs more:
// a factual question must score at least this ("Have you applied to X before?" is not "Have you
// worked for X before?").
export const FACTUAL_THRESHOLD = 0.75;

// The concept a capitalised name or a {slot} becomes: "Example Corp", "Canada" and "PostgreSQL" all
// stand in the same place in a question.
export const NAME = "{name}";

// Words that carry no intent in an application question ("Tell me about a time when you…").
const FILLER = new Set(
  (
    "a an the and or but of in on at to for with by from about as into over is are was were be " +
    "been being am do does did have has had having you your yours yourselves i me my we they " +
    "them their it its this that these those what which who whom whose when where " +
    "how many much can could would should will shall may might must please tell describe " +
    "share explain give provide walk talk example instance time times situation if so any some " +
    "most more best greatest biggest very just not no yes there then than also through made make " +
    "kind type one out up all each other such only own lot bit"
  ).split(" "),
);

// Words with the same intent, mapped to one concept by prefix. Longer prefixes are tried first,
// so "linkedin" wins over "link", "employer" over "employ" and "teammate" over "team".
const CONCEPTS: Record<string, readonly string[]> = {
  interest: ["interest", "excit", "motivat", "attract", "appeal", "passion", "drawn", "want"],
  role: ["role", "position", "job", "opportunit", "opening", "vacanc", "posting"],
  company: ["us", "our", "here", "company", "compan", "organization", "organisation", "employer"],
  work: ["work", "join"],
  // Kept apart from "work": "Have you worked with React before?" is not about employment.
  employment: ["employ"],
  // "why" carries the intent of "Why us?", "Why this role?" and "Why are you leaving?".
  why: ["why"],
  year: ["year", "yrs"],
  experience: ["experienc", "familiar"],
  authorization: ["authori", "eligib", "legal", "right"],
  sponsorship: ["sponsor", "visa"],
  need: ["need", "requir"],
  relocate: ["relocat"],
  location: ["locat", "live", "living", "based", "city", "reside"],
  arrangement: ["remote", "hybrid", "on-site", "onsite", "in-office", "office"],
  start: ["start", "availab"],
  date: ["date"],
  notice: ["notice"],
  salary: ["salar", "compensation", "wage"],
  expectation: ["expect", "desir"],
  source: ["hear", "heard", "find", "referr"],
  previous: ["previous", "former", "ever", "before"],
  linkedin: ["linkedin"],
  url: ["url", "link"],
  portfolio: ["portfolio", "website", "github"],
  yourself: ["yourself", "background", "introduc"],
  challenge: ["challeng", "difficult", "hard", "tough"],
  project: ["project", "initiative", "problem"],
  accomplish: ["accomplish", "achiev", "proud"],
  conflict: ["conflict", "disagree", "disput", "tension"],
  colleague: ["colleague", "coworker", "co-worker", "teammate", "peer"],
  failure: ["fail", "mistake", "setback"],
  lead: ["lead", "led"],
  ambiguity: ["ambigu", "uncertain", "unclear"],
  strength: ["strength"],
  weakness: ["weak", "improv"],
  leave: ["leav", "left", "quit"],
  current: ["current", "last"],
  goal: ["goal", "aspir", "career"],
  team: ["team", "environment", "culture"],
  manager: ["manag", "boss", "supervis"],
  know: ["know", "knew"],
  bring: ["bring", "contribut"],
};

// Words that flip a question's meaning ("Do you NOT need…", "Why wouldn't you…"). The one copy:
// matching, confirming and package assembly all ask `isNegatedQuestion` (NS-244).
const NEGATION = /\b(?:without|not|no|never)\b|n't\b/i;

// Characters that stand in for a letter or the apostrophe of a negation and that no other rule
// refuses (NS-274): an employer's label could write "wouldn`t", "n0t" or "nøt" to hide the word
// from NEGATION while the matcher still reads the rest. They are ASCII or Latin letters that real
// labels and company names need, so the disguise rule (question-reuse.ts) can't refuse them; the
// negation check reads through them instead.
const APOSTROPHE_LIKE = /[`\u00b4]/g;
const LOOKALIKE: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "\u00f8": "o", // ø
  "\ua74b": "o", // ꝋ, o with a long stroke
  "\ua74d": "o", // ꝍ, o with a loop
  "\u0167": "t", // ŧ
  "\u0131": "i", // ı, dotless i
  "\u0142": "l", // ł
};
const LOOKALIKE_CHARS = new RegExp(`[${Object.keys(LOOKALIKE).join("")}]`, "g");

// The label as the negation check reads it: apostrophe stand-ins as "'", normalized (NFKC, curly
// quotes), accents and other marks stripped ("nót" and "nǫt" read "not"), lowercase, then each
// lookalike above as its letter. Only NEGATION reads it, never the matcher or a company name.
export function negationSkeleton(label: string): string {
  const marked = normalize(label.replace(APOSTROPHE_LIKE, "'"));
  const bare = marked.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  return bare.replace(LOOKALIKE_CHARS, (c) => LOOKALIKE[c] ?? c);
}

// Is this question negated? Normalized first (NFKC, curly quotes), so "wouldn’t" and
// full-width letters count the same as plain ASCII; since NS-274 also read through lookalikes
// (negationSkeleton). Either reading counts, so the skeleton only ever adds negations.
export const isNegatedQuestion = (label: string): boolean =>
  NEGATION.test(normalize(label)) || NEGATION.test(negationSkeleton(label));

// "us" after these verbs is the reader of the form ("Tell us about…"), not the company ("Why us?").
const ADDRESS_VERBS = new Set(["tell", "give", "show", "send", "let"]);

// [prefix, concept] pairs, longest prefix first.
const PREFIXES: ReadonlyArray<readonly [string, string]> = Object.entries(CONCEPTS)
  .flatMap(([concept, prefixes]) => prefixes.map((p) => [p, concept] as const))
  .sort((a, b) => b[0].length - a[0].length);

function conceptOf(word: string): string | undefined {
  // A two-letter prefix ("us") must match the whole word, or it would catch "used" and "user".
  return PREFIXES.find(([p]) => (p.length <= 2 ? word === p : word.startsWith(p)))?.[1];
}

// A word, a {slot} marker, or a sentence end (so the next word counts as a sentence start).
const TOKEN = /\{[a-z]+\}|[\p{L}\p{N}][\p{L}\p{N}+#'-]*|[.?!:]/gu;

// The set of concepts a question is about (see the spec for the rules).
export function questionConcepts(question: string): Set<string> {
  const text = normalize(question);
  // A question written all in capitals has no usable capitalisation, so no name detection.
  const allCaps = !/\p{Ll}/u.test(text);
  const concepts = new Set<string>();
  let sentenceStart = true;
  let previous = "";
  for (const raw of text.match(TOKEN) ?? []) {
    if (/^[.?!:]$/.test(raw)) {
      sentenceStart = true;
      previous = "";
      continue;
    }
    const first = sentenceStart;
    sentenceStart = false;
    const before = previous;
    previous = raw.toLowerCase();
    if (raw.startsWith("{")) {
      concepts.add(NAME);
      continue;
    }
    // "Example's" → "Example", "you're" → "you"; a trailing hyphen or apostrophe is punctuation.
    const token = raw.replace(/'(s|re|ve|ll|d|m)$/i, "").replace(/['-]+$/, "");
    const word = token.toLowerCase();
    if (word === "") continue;
    // "the US" is a country, not "us"; "tell us" addresses the reader.
    if (token === "US") {
      concepts.add(NAME);
      continue;
    }
    if (word === "us" && ADDRESS_VERBS.has(before)) continue;
    const concept = conceptOf(word);
    if (concept !== undefined) {
      concepts.add(concept);
    } else if (
      !allCaps &&
      !first &&
      token.length > 1 &&
      /^\p{Lu}/u.test(token) &&
      // A filler word in capitals ("Are you NOT willing…") is emphasis, not a name.
      !(token === token.toUpperCase() && FILLER.has(word))
    ) {
      // Checked before the filler words, so a company called "Example" is still a name. "I" is
      // one letter and never a name.
      concepts.add(NAME);
    } else if (FILLER.has(word)) {
      continue;
    } else {
      // Any other word stands for itself, without a plural "s" ("problems" → "problem").
      concepts.add(word.length > 3 && /[^s]s$/.test(word) ? word.slice(0, -1) : word);
    }
  }
  return concepts;
}

// Dice coefficient of two concept sets: 1 when equal, 0 when they share nothing.
function dice(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const c of a) if (b.has(c)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

// Every catalog wording's concepts, computed once.
const WORDINGS: ReadonlyArray<{ question: CanonicalQuestion; concepts: Set<string> }> =
  CANONICAL_QUESTIONS.flatMap((question: CanonicalQuestion) =>
    [question.text, ...question.examples].map((w) => ({ question, concepts: questionConcepts(w) })),
  );

export type QuestionMatch =
  | {
      status: "matched";
      canonical: CanonicalQuestion;
      confidence: number;
      // Set only by confirmQuestion (NS-137) when the model, not code, chose the canonical
      // question. Such a match is never reuse for the Gate's policy (bank_exact or
      // bank_high_confidence): its confidence is the lexical score of a question code had left new.
      confirmedBy?: "model";
    }
  | {
      status: "new";
      reason: "empty" | "below_threshold" | "ambiguous" | "negated";
      confidence: number;
      nearest: string | null;
    };

// Two decimals, so a confidence shows as 0.86 rather than 0.857142…
const round = (n: number) => Math.round(n * 100) / 100;

// Every canonical question with its best score over its wordings, highest first (ties keep the
// catalog's order). Empty when the question has no concepts.
export function rankCanonical(
  question: string,
): Array<{ canonical: CanonicalQuestion; score: number }> {
  const concepts = questionConcepts(question);
  if (concepts.size === 0) return [];
  const best = new Map<CanonicalQuestion, number>();
  for (const w of WORDINGS) {
    const score = dice(concepts, w.concepts);
    if (score > (best.get(w.question) ?? -1)) best.set(w.question, score);
  }
  return [...best.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([canonical, score]) => ({ canonical, score }));
}

// Maps a form question to a canonical question with a confidence score (ANS-002).
export function matchQuestion(question: string): QuestionMatch {
  const scored = rankCanonical(question);
  if (scored.length === 0) return { status: "new", reason: "empty", confidence: 0, nearest: null };
  const ranked = scored.map((r) => [r.canonical, r.score] as const);
  const [top, runnerUp] = ranked;
  if (top === undefined || top[1] === 0) {
    return { status: "new", reason: "below_threshold", confidence: 0, nearest: null };
  }
  const [canonical, score] = top;
  const confidence = round(score);
  const threshold = canonical.kind === "factual" ? FACTUAL_THRESHOLD : MATCH_THRESHOLD;
  if (score < threshold) {
    return { status: "new", reason: "below_threshold", confidence, nearest: canonical.id };
  }
  // A factual setting answers one polarity: "Do you need sponsorship?" and "Can you work without
  // sponsorship?" share a field but have opposite answers, so a negated factual question is new.
  if (canonical.kind === "factual" && isNegatedQuestion(question)) {
    return { status: "new", reason: "negated", confidence, nearest: canonical.id };
  }
  // One setting can't answer two questions: "Are you authorized to work here and will you need
  // sponsorship?" passes the factual threshold for both, so it is ambiguous whatever the margin.
  const secondFactual =
    canonical.kind === "factual" &&
    ranked.slice(1).some(([q, s]) => q.kind === "factual" && s >= FACTUAL_THRESHOLD);
  // Compared on the rounded values so the margin means what it says (0.86 vs 0.76 is ambiguous).
  if (
    secondFactual ||
    (runnerUp !== undefined && confidence - round(runnerUp[1]) <= AMBIGUITY_MARGIN)
  ) {
    return { status: "new", reason: "ambiguous", confidence, nearest: canonical.id };
  }
  return { status: "matched", canonical, confidence };
}

export interface QuestionClassification {
  kind: QuestionKind;
  // The profile setting that answers a factual question; null for every other kind.
  factualField: FactualField | null;
  match: QuestionMatch;
}

// Classifies a form question (ANS-001). A matched question takes its canonical question's kind.
// A new one is company-specific when it names the company, otherwise reusable narrative; never
// factual, because a factual answer is filled in without drafting and so needs a known field.
export function classifyQuestion(question: string): QuestionClassification {
  const match = matchQuestion(question);
  if (match.status === "matched") {
    return { kind: match.canonical.kind, factualField: match.canonical.factualField, match };
  }
  const concepts = questionConcepts(question);
  const namesCompany = concepts.has("company") || concepts.has(NAME);
  return {
    kind: namesCompany ? "company_specific" : "reusable_narrative",
    factualField: null,
    match,
  };
}
