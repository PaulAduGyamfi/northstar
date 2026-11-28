import { AnswerDraft, answerDraftRoute, validateAnswerDraft } from "@northstar/profile";
import { z } from "zod";
import { defineEval } from "../types.js";

// Eval set for the answer-draft route (NS-135, ANS-004). Cases live in
// evals/answer-draft/cases.jsonl: invented questions, stories and atoms only (the repo is public;
// Paul's real stories stay in his local database). The fixtures are hand-written until Paul
// records real ones (ADR-0016 item 8), so the baseline is provisional.
export const AnswerInput = z
  .object({
    question: z.string().min(1),
    limit: z.number().int().positive().nullable(),
    voiceGuide: z.string(),
    evidence: z
      .array(
        z
          .object({
            id: z.string().min(1),
            kind: z.enum(["story", "atom"]),
            text: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const AnswerExpected = z
  .object({
    // At least one of these ids must be cited: the evidence that answers the question.
    citesAnyOf: z.array(z.string().min(1)).min(1),
    // Whether the evidence is thin enough that the draft should ask follow-ups.
    followUps: z.boolean(),
    // Words that must not appear in the answer (an injected claim, an upgraded verb).
    absent: z.array(z.string()).optional(),
  })
  .strict();

// A case's story text is its title sentence, then its parts (storyEvidence's order): everything
// after the first sentence. A story with no second sentence leaves nothing to quote, which fails
// closed.
export function withoutTitle(text: string): string {
  const end = text.search(/[.!?]\s/);
  return end < 0 ? "" : text.slice(end + 1).trim();
}

// Passes only if the draft passes the same provenance check `draftAnswer` runs and meets the
// case's expectations.
export function gradeAnswerDraft(output: unknown, expected: unknown, input: unknown): boolean {
  const d = AnswerDraft.safeParse(output);
  const e = AnswerExpected.safeParse(expected);
  const i = AnswerInput.safeParse(input);
  if (!d.success || !e.success || !i.success) return false;
  const draft = d.data;
  const exp = e.data;

  // As in the app (NS-202, NS-265): a story's title is shown to the model but is no evidence, so
  // quotes and names are checked against the story's parts alone (`checkText`, as storyEvidence
  // builds it). The route still sees the case's text unchanged, so recorded requests keep their keys.
  const evidence = i.data.evidence.map((e) =>
    e.kind === "story" ? { ...e, checkText: withoutTitle(e.text) } : e,
  );
  if (!validateAnswerDraft(draft, evidence, i.data.limit).ok) return false;
  const cited = new Set(draft.sentences.flatMap((s) => s.cites.map((c) => c.id)));
  if (!exp.citesAnyOf.some((id) => cited.has(id))) return false;
  if (exp.followUps !== draft.followUps.length > 0) return false;
  const text = draft.sentences
    .map((s) => s.text)
    .join(" ")
    .toLowerCase();
  // Whole words, so "led" isn't found in "settled".
  const has = (w: string) =>
    new RegExp(`\\b${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text);
  if (exp.absent?.some(has)) return false;
  return true;
}

export const answerDraftEval = defineEval({
  route: answerDraftRoute(),
  inputSchema: AnswerInput,
  expectedSchema: AnswerExpected,
  grader: gradeAnswerDraft,
});
