import { z } from "zod";
import {
  dateOrNull,
  type Extraction,
  emptyFields,
  remoteFrom,
  wholeOrNull,
} from "../extraction.js";
import { type FetchDeps, safeFetch } from "../fetch.js";
import { safeJson } from "./greenhouse.js";

// Ashby's public posting API (api.ashbyhq.com/posting-api/job-board/<org>): the whole board in one
// response, so the posting is picked out by id. The company is the org slug from the URL.
const Component = z.object({
  compensationType: z.string(),
  interval: z.string().optional(),
  currencyCode: z.string().nullable().optional(),
  minValue: z.number().nullable().optional(),
  maxValue: z.number().nullable().optional(),
});
const Board = z.object({
  jobs: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      location: z.string().optional(),
      isRemote: z.boolean().optional(),
      workplaceType: z.string().nullable().optional(),
      descriptionPlain: z.string().optional(),
      publishedAt: z.string().optional(),
      jobUrl: z.string().optional(),
      applyUrl: z.string().optional(),
      compensation: z
        .object({ summaryComponents: z.array(Component).optional() })
        .nullable()
        .optional(),
    }),
  ),
});

const PERIODS: Record<string, "year" | "month" | "hour"> = {
  "1 YEAR": "year",
  "1 MONTH": "month",
  "1 HOUR": "hour",
};

export async function ashby(
  deps: FetchDeps,
  t: { org: string; postingId: string },
): Promise<Extraction | null> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(t.org)}?includeCompensation=true`;
  const res = await safeFetch(deps, url);
  if (res.status !== 200) return null;
  const parsed = Board.safeParse(safeJson(res.body));
  if (!parsed.success) return null;
  const p = parsed.data.jobs.find((j) => j.id.toLowerCase() === t.postingId);
  if (!p) return null;
  const salary = p.compensation?.summaryComponents?.find((c) => c.compensationType === "Salary");
  return {
    method: "ats_api",
    ats: "ashby",
    atsPostingId: p.id.toLowerCase(),
    fields: {
      ...emptyFields(),
      title: p.title,
      company: t.org,
      location: p.location ?? null,
      remote: remoteFrom(p.workplaceType, p.isRemote ? "remote" : null, p.location),
      salaryMin: wholeOrNull(salary?.minValue),
      salaryMax: wholeOrNull(salary?.maxValue),
      salaryCurrency: salary?.currencyCode ?? null,
      salaryPeriod: salary?.interval ? (PERIODS[salary.interval] ?? null) : null,
      applyUrl: p.applyUrl ?? p.jobUrl ?? null,
      ats: "ashby",
      description: p.descriptionPlain?.trim() || null,
      postedAt: dateOrNull(p.publishedAt),
    },
  };
}
