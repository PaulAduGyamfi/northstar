import { checkJobProvenance, JobExtract, jobExtractRoute } from "@northstar/sources";
import { z } from "zod";
import { defineEval } from "../types.js";

// Eval set for the job-extract route (NS-114, NFR-AIQ-001). Cases live in
// evals/job-extract/cases.jsonl: invented companies on .example domains only.
export const PageInput = z.object({ url: z.string().min(1), text: z.string() }).strict();

export const PageExpected = z
  .object({
    isJobPosting: z.boolean(),
    title: z.string().nullable().optional(),
    company: z.string().nullable().optional(),
    salaryMin: z.number().nullable().optional(),
    salaryMax: z.number().nullable().optional(),
    remote: z.enum(["onsite", "hybrid", "remote"]).nullable().optional(),
    // How many requirement items the page lists (all must survive the provenance check).
    requirements: z.number().optional(),
    // Strings that must not appear anywhere in the output (an injected value, a board's name).
    absent: z.array(z.string()).optional(),
  })
  .strict();

const same = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : a.trim().toLowerCase() === b.trim().toLowerCase();

// Passes when the fields the case names are right after the same provenance check ingest runs,
// nothing was dropped for not being in the page, and no absent string appears.
export function gradeJobExtract(output: unknown, expected: unknown, input: unknown): boolean {
  const o = JobExtract.safeParse(output);
  const e = PageExpected.safeParse(expected);
  const i = PageInput.safeParse(input);
  if (!o.success || !e.success || !i.success) return false;
  const exp = e.data;
  if (o.data.isJobPosting !== exp.isJobPosting) return false;
  const { fields, dropped } = checkJobProvenance(o.data, i.data.text);
  if (dropped.length > 0) return false;
  if (exp.title !== undefined && !same(fields.title, exp.title)) return false;
  if (exp.company !== undefined && !same(fields.company, exp.company)) return false;
  if (exp.salaryMin !== undefined && fields.salaryMin !== exp.salaryMin) return false;
  if (exp.salaryMax !== undefined && fields.salaryMax !== exp.salaryMax) return false;
  if (exp.remote !== undefined && fields.remote !== exp.remote) return false;
  if (exp.requirements !== undefined && fields.requirements.length !== exp.requirements)
    return false;
  // Values only: the field names themselves ("seniority") must not count as the output saying
  // "Senior".
  const all = JSON.stringify(Object.values(o.data)).toLowerCase();
  return !(exp.absent ?? []).some((s) => all.includes(s.toLowerCase()));
}

export const jobExtractEval = defineEval({
  route: jobExtractRoute(),
  inputSchema: PageInput,
  expectedSchema: PageExpected,
  grader: gradeJobExtract,
});
