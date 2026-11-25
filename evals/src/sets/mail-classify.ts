import {
  checkMailProvenance,
  MAIL_KINDS,
  MailClassification,
  mailClassifyRoute,
  STAGE_SIGNALS,
} from "@northstar/inbox";
import { z } from "zod";
import { defineEval } from "../types.js";

// Eval set for the mail-classify route (NS-113, NFR-AIQ-001). Cases live in
// evals/mail-classify/cases.jsonl: invented companies and people only. Real-mail cases belong in
// evals/mail-classify/private/ (gitignored) and are never recorded (llm.md).
export const MailInput = z
  .object({
    from: z.string().min(1),
    subject: z.string(),
    date: z.string().min(1),
    body: z.string(),
  })
  .strict();

export const MailExpected = z
  .object({
    kind: z.enum(MAIL_KINDS),
    // The employer, or null when the email doesn't name one.
    company: z.string().nullable(),
    stageSignal: z.enum(STAGE_SIGNALS),
    // Strings that must not appear in the output (an injected payload, an ATS vendor's name).
    absent: z.array(z.string()).optional(),
  })
  .strict();

const same = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : a.trim().toLowerCase() === b.trim().toLowerCase();

// Passes only if the kind, employer and stage are right and every extracted name is in the email
// (the same deterministic check the backfill runs).
export function gradeMailClassify(output: unknown, expected: unknown, input: unknown): boolean {
  const o = MailClassification.safeParse(output);
  const e = MailExpected.safeParse(expected);
  const i = MailInput.safeParse(input);
  if (!o.success || !e.success || !i.success) return false;
  if (o.data.kind !== e.data.kind || o.data.stageSignal !== e.data.stageSignal) return false;
  if (!same(o.data.company, e.data.company)) return false;
  if (checkMailProvenance(o.data, i.data).length > 0) return false;
  const all = JSON.stringify(o.data).toLowerCase();
  return !(e.data.absent ?? []).some((s) => all.includes(s.toLowerCase()));
}

export const mailClassifyEval = defineEval({
  route: mailClassifyRoute(),
  inputSchema: MailInput,
  expectedSchema: MailExpected,
  grader: gradeMailClassify,
});
