import {
  VerificationChoice,
  type VerificationExtractInput,
  verificationExtractRoute,
} from "@northstar/inbox";
import { z } from "zod";
import { defineEval } from "../types.js";

// Eval set for the verification-extract route (NS-149, VER-003). Cases live in
// evals/verification-extract/cases.jsonl: invented mails with placeholder codes (111111) and
// example.com links only (VER-005; the repo is public). The fixtures are hand-written until Paul
// records real ones (ADR-0016 item 8), so the baseline is provisional.

export const VerificationExtractCase = z
  .object({
    body: z.string(),
    kind: z.enum(["code", "link"]),
    candidates: z.array(z.string()).min(2),
  })
  .strict();

export const VerificationExtractExpected = z
  .object({ choice: z.number().int().nullable() })
  .strict();

// Passes only on exactly the expected index (or null). A wrong index is worse than null: null
// hands the step to Paul, a wrong code fails the sign-up.
export function gradeVerificationExtract(output: unknown, expected: unknown): boolean {
  const o = VerificationChoice.safeParse(output);
  const e = VerificationExtractExpected.safeParse(expected);
  return o.success && e.success && o.data.choice === e.data.choice;
}

const route = verificationExtractRoute();
export const verificationExtractEval = defineEval({
  route,
  inputSchema: VerificationExtractCase satisfies z.ZodType<VerificationExtractInput>,
  expectedSchema: VerificationExtractExpected,
  grader: gradeVerificationExtract,
});
