import { checkRecruiterFacts, RecruiterFacts, recruiterExtractRoute } from "@northstar/inbox";
import { z } from "zod";
import { defineEval } from "../types.js";

// Eval set for the recruiter-extract route (NS-167, REC-001). Cases live in
// evals/recruiter-extract/cases.jsonl: invented recruiters, companies and emails only (the repo
// is public; real mail stays in evals/**/private/). The fixtures are hand-written until Paul
// records real ones (ADR-0016 item 8), so the baseline is provisional.
export const RecruiterInput = z.object({ email: z.string().min(1) }).strict();

// What a correct reading holds: each listed field's exact value, and the red flags by kind.
export const RecruiterExpected = z
  .object({
    fields: RecruiterFacts.omit({ redFlags: true }).partial(),
    redFlags: z.array(z.string()),
  })
  .strict();

// Passes only if the check drops nothing (the model stated only what the email says), every
// listed field matches, and the red flags are exactly the expected kinds.
export function gradeRecruiterExtract(output: unknown, expected: unknown, input: unknown): boolean {
  const o = RecruiterFacts.safeParse(output);
  const e = RecruiterExpected.safeParse(expected);
  const i = RecruiterInput.safeParse(input);
  if (!o.success || !e.success || !i.success) return false;
  const { facts, dropped } = checkRecruiterFacts(o.data, i.data.email);
  if (dropped.length > 0) return false;
  for (const [field, value] of Object.entries(e.data.fields)) {
    if (facts[field as keyof typeof facts] !== value) return false;
  }
  const kinds = [...new Set(facts.redFlags.map((f) => f.kind))].sort();
  return JSON.stringify(kinds) === JSON.stringify([...e.data.redFlags].sort());
}

export const recruiterExtractEval = defineEval({
  route: recruiterExtractRoute(),
  inputSchema: RecruiterInput,
  expectedSchema: RecruiterExpected,
  grader: gradeRecruiterExtract,
});
