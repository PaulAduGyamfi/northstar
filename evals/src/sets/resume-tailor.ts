import type { Route } from "@northstar/llm";
import {
  checkModelResume,
  type MasterResume,
  resumeTailorInput,
  resumeTailorRoute,
  TailoredResume,
  type TailorJob,
  tailorResume,
} from "@northstar/profile";
import { z } from "zod";
import { defineEval } from "../types.js";

// Eval set for the resume-tailor route (NS-144, TLR-001/002). Cases live in
// evals/resume-tailor/cases.jsonl: invented masters and postings only (the repo is public). The
// fixtures are hand-written until Paul records real ones (ADR-0016 item 8), so the baseline is
// provisional. The cases cover what the validator can't see (NS-117's known limits): an
// enlarged number word ("120 billion"), an upgraded verb, an injection in the posting.

const Month = z.string().nullable();
export const TailorCaseInput = z
  .object({
    master: z.object({
      roles: z.array(
        z.object({
          id: z.string(),
          employer: z.string(),
          title: z.string(),
          startMonth: Month,
          endMonth: Month,
          isCurrent: z.boolean(),
        }),
      ),
      education: z.array(
        z.object({
          school: z.string(),
          degree: z.string().nullable(),
          field: z.string().nullable(),
          endMonth: Month,
        }),
      ),
      atoms: z.array(
        z.object({
          id: z.string(),
          roleId: z.string().nullable(),
          what: z.string(),
          how: z.array(z.string()),
          sourceQuote: z.string(),
        }),
      ),
      skills: z.array(z.string()),
    }),
    job: z.object({
      title: z.string().nullable(),
      requirements: z.array(z.string()),
      niceToHaves: z.array(z.string()),
    }),
  })
  .strict();
type TailorCase = { master: MasterResume; job: TailorJob };

export const TailorExpected = z
  .object({
    // Whether the resume should carry a summary.
    summary: z.boolean(),
    // Words that must not appear in the summary, lines or skills (an enlarged number word, an
    // upgraded verb, an injected technology).
    absent: z.array(z.string()),
  })
  .strict();

// The route as the eval runs it: from a master and a job to exactly the request tailorWithModel
// sends (the deterministic tailor's resume as the base).
const real = resumeTailorRoute();
const evalRoute: Route<TailorCase, TailoredResume> = {
  ...real,
  render: ({ master, job }) =>
    real.render(resumeTailorInput(master, job, tailorResume(master, job))),
};

const escapeRegExp = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Passes only if the resume passes every check tailorWithModel runs and meets the case.
export function gradeResumeTailor(output: unknown, expected: unknown, input: unknown): boolean {
  const o = TailoredResume.safeParse(output);
  const e = TailorExpected.safeParse(expected);
  const i = TailorCaseInput.safeParse(input);
  if (!o.success || !e.success || !i.success) return false;
  const { master, job } = i.data;
  if (checkModelResume(o.data, master, job, tailorResume(master, job)).length > 0) return false;
  if (e.data.summary !== o.data.summary.length > 0) return false;
  const text = [
    ...o.data.summary.map((l) => l.text),
    ...o.data.sections.flatMap((s) => s.lines.map((l) => l.text)),
    ...o.data.skills.map((s) => s.name),
  ]
    .join(" \n ")
    .toLowerCase();
  return !e.data.absent.some((w) =>
    new RegExp(`\\b${escapeRegExp(w.toLowerCase())}\\b`).test(text),
  );
}

export const resumeTailorEval = defineEval({
  route: evalRoute,
  inputSchema: TailorCaseInput,
  expectedSchema: TailorExpected,
  grader: gradeResumeTailor,
});
