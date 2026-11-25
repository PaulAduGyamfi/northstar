import { z } from "zod";

// What the job-extract route returns for one page (NS-114). Text values are copied from the page;
// plain code then drops any that the page doesn't contain (checkJobProvenance).
export const JobExtract = z
  .object({
    isJobPosting: z.boolean(),
    title: z.string().nullable(),
    company: z.string().nullable(),
    location: z.string().nullable(),
    remote: z.enum(["onsite", "hybrid", "remote"]).nullable(),
    salaryMin: z.number().nullable(),
    salaryMax: z.number().nullable(),
    salaryCurrency: z.string().nullable(),
    salaryPeriod: z.enum(["year", "month", "hour"]).nullable(),
    seniority: z.string().nullable(),
    requirements: z.array(z.string()),
    niceToHaves: z.array(z.string()),
    // The posting date exactly as the page writes it ("Posted November 21, 2026"), or null.
    postedText: z.string().nullable(),
  })
  .strict();

export type JobExtract = z.infer<typeof JobExtract>;
