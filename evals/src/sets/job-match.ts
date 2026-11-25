import {
  checkJobMatches,
  type JobMatchInput,
  JobMatchOutput,
  jobMatchRoute,
} from "@northstar/sources";
import { z } from "zod";
import { defineEval } from "../types.js";

// Eval set for the job-match route (NS-138, MAT-001/002). Cases live in
// evals/job-match/cases.jsonl: invented requirements and atoms only (the repo is public). The
// fixtures are hand-written until Paul records real ones (ADR-0016 item 8), so the baseline is
// provisional. The cases cover what checkJobMatches can't see: a quote that is really in the
// atom but doesn't meet the requirement (years the atom never states), and an injection in a
// requirement.

export const JobMatchCaseInput = z
  .object({
    requirements: z.array(z.string()),
    atoms: z.array(
      z.object({ id: z.string(), what: z.string(), how: z.array(z.string()) }).strict(),
    ),
  })
  .strict();

export const JobMatchExpected = z
  .object({
    // The requirement indexes that should end up matched, each with its atom. Every other
    // requirement must stay unmatched.
    matched: z.array(z.object({ requirement: z.number().int(), atomId: z.string() }).strict()),
  })
  .strict();

// Passes only when what survives checkJobMatches is exactly the expected matches.
export function gradeJobMatch(output: unknown, expected: unknown, input: unknown): boolean {
  const o = JobMatchOutput.safeParse(output);
  const e = JobMatchExpected.safeParse(expected);
  const i = JobMatchCaseInput.safeParse(input);
  if (!o.success || !e.success || !i.success) return false;
  const typed: JobMatchInput = i.data;
  const kept = checkJobMatches(o.data, typed)
    .map((m) => `${typed.requirements.indexOf(m.requirement)}:${m.atomId}`)
    .sort();
  const want = e.data.matched.map((m) => `${m.requirement}:${m.atomId}`).sort();
  return JSON.stringify(kept) === JSON.stringify(want);
}

export const jobMatchEval = defineEval({
  route: jobMatchRoute(),
  inputSchema: JobMatchCaseInput,
  expectedSchema: JobMatchExpected,
  grader: gradeJobMatch,
});
