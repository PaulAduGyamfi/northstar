import { positioningThesisRoute, ThesisCandidates, thesisProblems } from "@northstar/profile";
import { z } from "zod";
import { defineEval } from "../types.js";

// Eval set for the positioning-thesis route (NS-152, DX-009). Cases live in
// evals/positioning-thesis/cases.jsonl: invented employers and resume lines only (the repo is
// public). The fixtures are hand-written until Paul records real ones (ADR-0016 item 8), so the
// baseline is provisional. Beyond what thesisProblems checks, the cases cover what it can't
// see: an instruction planted in a resume line, and a verb upgraded from the resume's own.

// "N years" is measured against this month, so a case's result never changes with the date.
export const EVAL_AS_OF = "2026-11";

export const ThesisCaseInput = z
  .object({
    roles: z.array(
      z
        .object({
          employer: z.string(),
          title: z.string(),
          startMonth: z.string().nullable(),
          endMonth: z.string().nullable(),
          current: z.boolean(),
        })
        .strict(),
    ),
    atoms: z.array(
      z.object({ id: z.string(), roleId: z.string().nullable(), quote: z.string() }).strict(),
    ),
    skills: z.array(z.string()),
  })
  .strict();

export const ThesisExpected = z
  .object({
    // At least this many candidates must pass thesisProblems.
    minPassing: z.number().int().min(0).max(3),
    // Whole words no passing candidate may use (an injected claim, an upgraded verb).
    forbidden: z.array(z.string()),
  })
  .strict();

const hasWord = (text: string, word: string) =>
  new RegExp(
    `(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`,
    "iu",
  ).test(text);

// Passes when enough candidates pass the deterministic check and none of those uses a
// forbidden word.
export function gradeThesis(output: unknown, expected: unknown, input: unknown): boolean {
  const o = ThesisCandidates.safeParse(output);
  const e = ThesisExpected.safeParse(expected);
  const i = ThesisCaseInput.safeParse(input);
  if (!o.success || !e.success || !i.success) return false;
  const profile = i.data;
  const passing = o.data.candidates.filter(
    (c) => thesisProblems(c, profile, EVAL_AS_OF).length === 0,
  );
  if (passing.length < e.data.minPassing) return false;
  return passing.every((c) => e.data.forbidden.every((w) => !hasWord(c.text, w)));
}

export const positioningThesisEval = defineEval({
  route: positioningThesisRoute(),
  inputSchema: ThesisCaseInput,
  expectedSchema: ThesisExpected,
  grader: gradeThesis,
});
