import type { EvidenceItem } from "../answer/evidence.js";
import {
  type AnswerFailure,
  NUMBER_WORDS,
  STARTERS,
  validateAnswerDraft,
} from "../answer/validate.js";
import { nameCandidates } from "../names.js";
import { hasWhole, normalize } from "../validate.js";
import type { ReplyDraft } from "./schema.js";

// The deterministic check for reply drafts (RPL-001, ADR-0004, NS-166): plain code, no model.
// A claim (a sentence that cites) passes the answer-draft rules. Framing (a sentence that cites
// nothing) may greet and thank, but can't carry a fact: no numbers, no times, no capitalised word
// that isn't an opener, a greeting or a name in the email itself, and only a few short sentences.
// A failure names the sentence and the problem, never the text.
export type ReplyFailure = AnswerFailure;
export type ReplyValidation = { ok: true } | { ok: false; failures: ReplyFailure[] };

export const MAX_FRAMING_SENTENCES = 3;
export const MAX_FRAMING_WORDS = 25;

// Greeting and sign-off words a reply opens or closes with. Capitalised, so they'd otherwise
// count as names.
const GREETINGS = new Set(
  (
    "Hi Hello Hey Dear Thanks Thank Best Regards Kind Warm Sincerely Cheers Looking Happy Glad " +
    "Great Please Yes Sure Absolutely Certainly Of"
  ).split(" "),
);

// Words that set a time. No reply proposes one until Calendar exists (RPL-003, NS-169). "May"
// and "March" are left out: as ordinary words ("you may") they would refuse plain framing.
const TIME_WORDS = new Set(
  (
    "monday tuesday wednesday thursday friday saturday sunday mondays tuesdays wednesdays " +
    "thursdays fridays weekend weekends week weeks tomorrow tonight morning mornings afternoon " +
    "afternoons evening evenings noon midnight am pm a.m p.m january february april may " +
    "june july august september october november december o'clock"
  ).split(" "),
);

// Edge punctuation off ("Hi," → "Hi", "a.m." → "a.m"), keeping name characters such as + and #.
const bare = (raw: string) => raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}+#]+$/gu, "");

function framingFailures(text: string, email: string, fail: (problem: string) => void): void {
  const words = normalize(text).split(" ");
  if (words.length > MAX_FRAMING_WORDS) {
    fail(`framing is longer than ${MAX_FRAMING_WORDS} words`);
  }
  const seen = new Set<string>();
  words.forEach((raw, position) => {
    const word = bare(raw);
    const lower = word.toLowerCase();
    // Any digit, or a number in words: framing states no figure of any kind.
    if (/\p{N}/u.test(word) || NUMBER_WORDS.has(lower)) {
      fail(`framing has a number at word ${position}`);
    }
    if (TIME_WORDS.has(lower)) fail(`framing has a time at word ${position}`);
    let unbacked = false;
    for (const { name, leading } of nameCandidates(word)) {
      // Openers only open a sentence; greetings may stand anywhere ("Thanks again, and best").
      if (leading && (GREETINGS.has(name) || (position === 0 && STARTERS.has(name)))) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      // A name may come only from the email (the recruiter's or the company's name), never from
      // the model: framing must not bring in an employer, tool or place of its own.
      if (!hasWhole(email, name)) unbacked = true;
    }
    if (unbacked) fail(`framing has a name at word ${position} that isn't in the email`);
  });
}

export function validateReplyDraft(
  draft: ReplyDraft,
  evidence: readonly EvidenceItem[],
  // The email as the route saw it (cut to EMAIL_LIMIT).
  email: string,
): ReplyValidation {
  const failures: ReplyFailure[] = [];
  if (draft.sentences.length === 0) failures.push({ sentence: null, problem: "no sentences" });

  // Claims: the answer-draft rules, sentence by sentence, with failures mapped back to the
  // reply's own sentence numbers.
  const claimIndex = draft.sentences.flatMap((s, i) => (s.cites.length > 0 ? [i] : []));
  if (claimIndex.length > 0) {
    const claims = claimIndex.map((i) => draft.sentences[i] as ReplyDraft["sentences"][number]);
    const check = validateAnswerDraft({ sentences: claims, followUps: [] }, evidence, null);
    if (!check.ok) {
      for (const f of check.failures) {
        failures.push({
          sentence: f.sentence === null ? null : (claimIndex[f.sentence] ?? null),
          problem: f.problem,
        });
      }
    }
  }

  const normalizedEmail = normalize(email);
  const framing = draft.sentences.flatMap((s, i) => (s.cites.length === 0 ? [i] : []));
  if (framing.length > MAX_FRAMING_SENTENCES) {
    failures.push({
      sentence: null,
      problem: `more than ${MAX_FRAMING_SENTENCES} framing sentences`,
    });
  }
  for (const index of framing) {
    const sentence = draft.sentences[index] as ReplyDraft["sentences"][number];
    framingFailures(sentence.text, normalizedEmail, (problem) =>
      failures.push({ sentence: index, problem }),
    );
  }
  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}

// The reply as Paul would send it: sentences joined with spaces.
export function replyText(draft: ReplyDraft): string {
  return draft.sentences.map((s) => s.text.trim()).join(" ");
}
