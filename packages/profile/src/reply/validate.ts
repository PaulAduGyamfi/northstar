import type { EvidenceItem } from "../answer/evidence.js";
import { type AnswerFailure, validateAnswerDraft } from "../answer/validate.js";
import { hasWhole, normalize } from "../validate.js";
import type { ReplyDraft } from "./schema.js";

// The deterministic check for reply drafts (RPL-001, ADR-0004, NS-166): plain code, no model.
// A claim (a sentence that cites) passes the answer-draft rules, and may not add a commitment
// word its quotes don't hold. Framing (a sentence that cites nothing) must be one of a fixed set
// of whole sentences (framingSentences): a greeting, a thank-you, "I'll send my availability
// shortly". So framing can't state a fact, figure, time, name or link, and can't say yes, whatever
// the email asks for. A failure names the sentence and the problem, never the text.
export type ReplyFailure = AnswerFailure;
export type ReplyValidation = { ok: true } | { ok: false; failures: ReplyFailure[] };

export const MAX_FRAMING_SENTENCES = 3;

// A greeting, alone or before a thank-you. "{name}" is the sender's first name (greetingName);
// without one, only the nameless forms are allowed.
export const GREETINGS = ["Hi {name},", "Hello {name},", "Dear {name},", "Hi,", "Hello,"] as const;
// Thank-yous, which may also follow a greeting in the same sentence.
export const THANKS = [
  "Thanks for reaching out.",
  "Thank you for reaching out.",
  "Thanks for the note.",
  "Thank you for the note.",
  "Thanks for following up.",
  "Thank you for following up.",
  "Thanks for the update.",
  "Thank you for the update.",
  "Thank you for the invitation.",
  "Thank you for the next step.",
] as const;
// Next steps and sign-offs. None answers a question or commits to anything but a reply.
export const NEXT_STEPS = [
  "I'll send my availability shortly.",
  "I'll get back to you soon.",
  "I'd be glad to talk more.",
  "Thanks again.",
  "Best regards,",
] as const;

// Every framing sentence allowed for this sender: the lists above, and a greeting followed by a
// thank-you ("Hi Dana, thanks for reaching out.", the thank-you's first letter lowered).
export function framingSentences(name: string | null): Set<string> {
  const greetings = GREETINGS.filter((g) => name !== null || !g.includes("{name}")).map((g) =>
    g.replace("{name}", name ?? ""),
  );
  const joined = greetings.flatMap((g) =>
    THANKS.map((t) => `${g} ${t.charAt(0).toLowerCase()}${t.slice(1)}`),
  );
  return new Set([...greetings, ...THANKS, ...NEXT_STEPS, ...joined]);
}

// Words that commit Paul to something or state terms, matched by their start so "accepted",
// "relocating" and "paid" are caught too. A claim may use one only when its own quotes hold that
// word ("We agreed to launch one week later" can be quoted).
const COMMITMENT_STEMS = [
  "accept",
  "declin",
  "agree",
  "sign",
  "relocat",
  "salar",
  "compensat",
  "pay",
  "paid",
  "sponsor",
  "visa",
  "clearance",
  "offer",
  "contract",
  "notice",
  "withdr",
  "availab",
  "start",
  "consent",
  "join",
  "resign",
  "begin",
  "immediate",
  "onsite",
  "remote",
] as const;
// Short answers that commit by themselves.
const ANSWER_WORDS = new Set(["yes", "no", "ok", "okay", "sure", "deal", "confirm", "confirmed"]);

export function isCommitmentWord(word: string): boolean {
  const w = word.toLowerCase();
  return ANSWER_WORDS.has(w) || COMMITMENT_STEMS.some((stem) => w.startsWith(stem));
}

// The sender's first name as a greeting may use it: one plain capitalised word of letters only
// from the From header (code parses it, never the model), and never a word that answers or
// commits ("Yes", "Accept"), since whoever sends the email chooses the display name. Anything else
// gives no name, and the greeting goes without one.
export function greetingName(senderName: string | null): string | null {
  const first = normalize(senderName ?? "").split(" ")[0] ?? "";
  if (!/^\p{Lu}\p{Ll}{1,39}$/u.test(first)) return null;
  return isCommitmentWord(first) ? null : first;
}

// Words that set a time. No reply proposes one until Calendar exists (RPL-003, NS-169), so a
// claim may use one only when its quotes do. "May", "March", "am" and "pm" are left out: as
// ordinary words ("you may", "I am") they would refuse plain claims.
const TIME_WORDS = new Set(
  (
    "today tomorrow tonight morning mornings afternoon afternoons evening evenings noon " +
    "midnight weekend weekends monday tuesday wednesday thursday friday saturday sunday " +
    "january february april june july august september october november december"
  ).split(" "),
);

// Characters that don't show (zero-width spaces, joiners, bidi marks): they can hide a word from
// the checks, so no reply sentence may hold one.
const INVISIBLE = /\p{Cf}/u;
// A letter outside the Latin script ("а" in Cyrillic looks like "a"). Claims may use one only in a
// word their quotes hold.
const NON_LATIN_LETTER = /(?=\p{L})\P{Script=Latin}/u;

// Claim words its quotes don't back: a link or address, a symbol (an emoji "✅" can say yes), a
// lookalike letter, a time or a commitment word, checked on each part of a joined word
// ("re-locate", "salary-wise").
function claimWordFailures(
  sentence: ReplyDraft["sentences"][number],
  fail: (problem: string) => void,
): void {
  const quotes = sentence.cites.map((c) => normalize(c.quote).toLowerCase()).join(" \n ");
  normalize(sentence.text)
    .split(" ")
    .forEach((word, position) => {
      const parts = word.split(/[^\p{L}\p{N}]+/u).filter((p) => p !== "");
      // Each part, and the parts joined back up ("re-locate" → "relocate"), unless quoted.
      const unquoted = [...parts, ...(parts.length > 1 ? [parts.join("")] : [])].filter(
        (p) => !hasWhole(quotes, p.toLowerCase()) && !hasWhole(quotes, word.toLowerCase()),
      );
      const lower = word.toLowerCase();
      if (/:\/\/|www\.|@/u.test(lower) && !quotes.includes(lower)) {
        fail(`word ${position} is a link or address that isn't in its quotes`);
      } else if (/\p{S}/u.test(word) && !quotes.includes(lower.replace(/[^\p{S}]/gu, ""))) {
        fail(`word ${position} has a symbol that isn't in its quotes`);
      } else if (unquoted.some((p) => NON_LATIN_LETTER.test(p))) {
        fail(`word ${position} has letters outside the Latin script that aren't in its quotes`);
      } else if (unquoted.some((p) => TIME_WORDS.has(p.toLowerCase()))) {
        fail(`time at word ${position} is not in its quotes`);
      } else if (unquoted.some(isCommitmentWord)) {
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
    claimWordFailures(draft.sentences[index] as ReplyDraft["sentences"][number], (problem) =>
      failures.push({ sentence: index, problem }),
    );
  }
  draft.sentences.forEach((sentence, index) => {
    if (INVISIBLE.test(sentence.text)) {
      failures.push({ sentence: index, problem: "the sentence has an invisible character" });
    }
  });

  const allowed = framingSentences(greetingName(senderName));
  const framing = draft.sentences.flatMap((s, i) => (s.cites.length === 0 ? [i] : []));
  if (framing.length > MAX_FRAMING_SENTENCES) {
    failures.push({
      sentence: null,
      problem: `more than ${MAX_FRAMING_SENTENCES} framing sentences`,
    });
  }
  for (const index of framing) {
    const sentence = draft.sentences[index] as ReplyDraft["sentences"][number];
    if (!allowed.has(normalize(sentence.text))) {
      failures.push({ sentence: index, problem: "framing is not one of the allowed sentences" });
    }
  }
  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}

// The reply as Paul would send it: sentences joined with spaces.
export function replyText(draft: ReplyDraft): string {
  return draft.sentences.map((s) => s.text.trim()).join(" ");
}
