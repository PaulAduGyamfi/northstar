import {
  QuestionChoice,
  type QuestionConfirmInput,
  questionConfirmRoute,
} from "@northstar/profile";
import { z } from "zod";
import { defineEval } from "../types.js";

// Eval set for the question-confirm route (NS-137, ANS-002). Cases live in
// evals/question-confirm/cases.jsonl: invented form questions, each with the catalog candidates
// `confirmCandidates` offers for it. The fixtures are hand-written until Paul records real ones
// (ADR-0016 item 8), so the baseline is provisional. Real form questions belong in
// evals/question-confirm/private/ (gitignored).

export const QuestionConfirmCase = z
  .object({
    question: z.string().min(1),
    candidates: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const QuestionConfirmExpected = z.object({ choice: z.number().int().nullable() }).strict();

// Passes only on exactly the expected index (or null). A wrong index is worse than null: null
// drafts a fresh answer for Paul to approve, a wrong one reuses the answer to another question.
export function gradeQuestionConfirm(output: unknown, expected: unknown): boolean {
  const o = QuestionChoice.safeParse(output);
  const e = QuestionConfirmExpected.safeParse(expected);
  return o.success && e.success && o.data.choice === e.data.choice;
}

const route = questionConfirmRoute();
export const questionConfirmEval = defineEval({
  route,
  inputSchema: QuestionConfirmCase satisfies z.ZodType<QuestionConfirmInput>,
  expectedSchema: QuestionConfirmExpected,
  grader: gradeQuestionConfirm,
});
