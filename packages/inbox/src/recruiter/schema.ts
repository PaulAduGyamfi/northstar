import { z } from "zod";

// What the recruiter-extract route reads out of one recruiter email (REC-001, NS-167). Only what
// the email states: anything else is null. checkRecruiterFacts (check.ts) proves every value is
// in the email before the grader sees it.

// Red flags the model may point to, each with a verbatim quote. A fixed list, so the grader's
// caps are plain code.
export const RED_FLAGS = ["upfront_fee", "sensitive_data", "vague_role", "unpaid_work"] as const;
export type RedFlag = (typeof RED_FLAGS)[number];

export const RecruiterFacts = z
  .object({
    roleTitle: z.string().min(1).max(200).nullable(),
    seniority: z.string().min(1).max(100).nullable(),
    company: z.string().min(1).max(200).nullable(),
    location: z.string().min(1).max(200).nullable(),
    remote: z.enum(["onsite", "hybrid", "remote"]).nullable(),
    salaryMin: z.number().positive().nullable(),
    salaryMax: z.number().positive().nullable(),
    // An ISO 4217 code ("USD").
    salaryCurrency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    salaryPeriod: z.enum(["year", "month", "hour"]).nullable(),
    // Whether the sender works for an agency rather than the hiring company. A judgment the
    // model makes from the text; null when the email doesn't say.
    agency: z.boolean().nullable(),
    // A verbatim quote that shows the email was written for this person (their work, a project).
    personalizedQuote: z.string().min(1).max(400).nullable(),
    redFlags: z
      .array(z.object({ kind: z.enum(RED_FLAGS), quote: z.string().min(1).max(400) }).strict())
      .max(5),
  })
  .strict();

export type RecruiterFacts = z.infer<typeof RecruiterFacts>;
