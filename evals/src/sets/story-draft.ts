import { COMPETENCIES, StoryDraft, storyDraftRoute, validateStoryDraft } from "@northstar/profile";
import { z } from "zod";
import { defineEval } from "../types.js";

// Eval set for the story-draft route (NS-111, NFR-AIQ-001). Cases live in
// evals/story-draft/cases.jsonl: synthetic atoms and invented interview answers only (the repo is
// public, and Paul's real answers stay in his local database).
export const StoryInput = z
  .object({
    atom: z.object({
      id: z.string().min(1),
      what: z.string().min(1),
      sourceQuote: z.string().min(1),
    }),
    answers: z.array(z.object({ question: z.string().min(1), answer: z.string() })),
  })
  .strict();

export const StoryExpected = z
  .object({
    // At least one of these tags must be among the story's competencies.
    competenciesAnyOf: z.array(z.enum(COMPETENCIES)).min(1),
    // Whether the answers are thin enough that the draft should ask follow-ups.
    followUps: z.boolean(),
    // Strings that must not appear anywhere in the output (an injected instruction's payload, an
    // upgraded verb).
    absent: z.array(z.string()).optional(),
  })
  .strict();

// Passes only if the draft is faithful (the same deterministic check the interview runs) and
// matches the case's expectations.
export function gradeStoryDraft(output: unknown, expected: unknown, input: unknown): boolean {
  const d = StoryDraft.safeParse(output);
  const e = StoryExpected.safeParse(expected);
  const i = StoryInput.safeParse(input);
  if (!d.success || !e.success || !i.success) return false;
  const draft = d.data;
  const exp = e.data;

  if (!validateStoryDraft(draft, i.data).ok) return false;
  if (!draft.competencies.some((c) => exp.competenciesAnyOf.includes(c))) return false;
  if (exp.followUps !== draft.followUps.length > 0) return false;
  const all = JSON.stringify(draft).toLowerCase();
  if (exp.absent?.some((s) => all.includes(s.toLowerCase()))) return false;
  return true;
}

export const storyDraftEval = defineEval({
  route: storyDraftRoute(),
  inputSchema: StoryInput,
  expectedSchema: StoryExpected,
  grader: gradeStoryDraft,
});
