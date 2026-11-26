import type { EvidenceItem } from "../answer/evidence.js";
import { type AnswerFailure, validateAnswerDraft } from "../answer/validate.js";
import { hasWhole, normalize } from "../validate.js";
import type { ReplyDraft } from "./schema.js";

// The deterministic check for reply drafts (RPL-001, ADR-0004, NS-166): plain code, no model.
// A claim (a sentence that cites) passes the answer-draft rules, and may not add a commitment
// word its quotes don't hold. Framing (a sentence that cites nothing) is a closed set: every word
// must be in FRAMING_WORDS, a fixed vocabulary of greetings, thanks and next steps, or be the
// sender's name. So framing can't state a fact, a figure, a time, a name or a link, whatever the
// email asks for. A failure names the sentence and the problem, never the text.
export type ReplyFailure = AnswerFailure;
export type ReplyValidation = { ok: true } | { ok: false; failures: ReplyFailure[] };

export const MAX_FRAMING_SENTENCES = 3;
export const MAX_FRAMING_WORDS = 25;

// Everything framing may say: greet, thank, acknowledge, say a reply or availability will follow,
// sign off. No "yes", "no", "accept", "sure" or anything that answers a question by itself.
export const FRAMING_WORDS = new Set(
  (
    "hi hello dear thanks thank you so much very for reaching out the your note message email " +
    "following up update next step invitation i i'm i am i'll i will i'd would be glad happy " +
    "pleased great to hear from it this and appreciate hope you're are well all best regards kind " +
    "warm many sincerely cheers looking forward talking speaking talk speak more with soon " +
    "shortly send my availability get back in touch a reply"
  ).split(" "),
);

// Words that commit Paul to something or state terms. A claim may use one only when its own
// quotes do ("We agreed to launch one week later" can be quoted); framing never can, since none
// is in FRAMING_WORDS.
export const COMMITMENT_WORDS = new Set(
  (
    "accept accepted accepting accepts decline declined declining declines agree agreed agreeing " +
    "sign signed signing relocate relocating relocation salary salaries compensation pay rate " +
    "sponsorship sponsor visa clearance offer offers contract notice withdraw withdrawing " +
    "available availability start starting"
  ).split(" "),
);

// The sender's first name as the greeting may use it: one plain word from the From header (code
// parses it, never the model). Anything else gives no name, and the greeting goes without.
export function greetingName(senderName: string | null): string | null {
  const first = senderName?.trim().split(/\s+/)[0] ?? "";
  return /^\p{Lu}[\p{L}'-]{0,39}$/u.test(first) ? first : null;
}

// Edge punctuation off ("Hi," → "Hi"), keeping name characters such as + and #.
const bare = (raw: string) => raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}+#]+$/gu, "");

function framingFailures(text: string, name: string | null, fail: (problem: string) => void): void {
  const words = normalize(text).split(" ");
  if (words.length > MAX_FRAMING_WORDS) {
    fail(`framing is longer than ${MAX_FRAMING_WORDS} words`);
  }
  words.forEach((raw, position) => {
    const word = bare(raw);
    if (word === "" || word === name) return;
    if (!FRAMING_WORDS.has(word.toLowerCase())) {
      fail(`framing word ${position} is not in the framing vocabulary`);
    }
  });
}

// A commitment word in a claim that its quotes don't hold: the model added it.
function commitmentFailures(
  sentence: ReplyDraft["sentences"][number],
  fail: (problem: string) => void,
): void {
  const quotes = sentence.cites.map((c) => normalize(c.quote).toLowerCase()).join(" \n ");
  normalize(sentence.text)
    .split(" ")
    .forEach((raw, position) => {
      const word = bare(raw).toLowerCase();
      if (COMMITMENT_WORDS.has(word) && !hasWhole(quotes, word)) {
        fail(`commitment word at word ${position} is not in its quotes`);
      }
    });
}

export function validateReplyDraft(
  draft: ReplyDraft,
  evidence: readonly EvidenceItem[],
  // The sender's display name from the From header, parsed by code (greetingName).
  senderName: string | null,
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

  for (const index of claimIndex) {
    commitmentFailures(draft.sentences[index] as ReplyDraft["sentences"][number], (problem) =>
      failures.push({ sentence: index, problem }),
    );
  }

  const name = greetingName(senderName);
  const framing = draft.sentences.flatMap((s, i) => (s.cites.length === 0 ? [i] : []));
  if (framing.length > MAX_FRAMING_SENTENCES) {
    failures.push({
      sentence: null,
      problem: `more than ${MAX_FRAMING_SENTENCES} framing sentences`,
    });
  }
  for (const index of framing) {
    const sentence = draft.sentences[index] as ReplyDraft["sentences"][number];
    framingFailures(sentence.text, name, (problem) => failures.push({ sentence: index, problem }));
  }
  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}

// The reply as Paul would send it: sentences joined with spaces.
export function replyText(draft: ReplyDraft): string {
  return draft.sentences.map((s) => s.text.trim()).join(" ");
}
