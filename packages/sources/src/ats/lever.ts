import { z } from "zod";
import {
  dateOrNull,
  type Extraction,
  emptyFields,
  htmlToText,
  remoteFrom,
  sortSections,
  wholeOrNull,
} from "../extraction.js";
import { type FetchDeps, safeFetch } from "../fetch.js";
import { safeJson } from "./greenhouse.js";

// Lever's public postings API (api.lever.co/v0/postings). It doesn't return the company's display
// name, so the company is the board's own slug as written in the URL, never an invented name.
const Posting = z.object({
  id: z.string(),
  text: z.string(),
  categories: z
    .object({ location: z.string().optional(), commitment: z.string().optional() })
    .optional(),
  workplaceType: z.string().optional(),
  descriptionPlain: z.string().optional(),
  lists: z.array(z.object({ text: z.string(), content: z.string() })).optional(),
  hostedUrl: z.string().optional(),
  applyUrl: z.string().optional(),
  createdAt: z.number().optional(),
  salaryRange: z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
      currency: z.string().optional(),
      interval: z.string().optional(),
    })
    .optional(),
});

const PERIODS: Record<string, "year" | "month" | "hour"> = {
  "per-year-salary": "year",
  "per-month-salary": "month",
  "per-hour-wage": "hour",
};

export async function lever(
  deps: FetchDeps,
  t: { company: string; postingId: string },
): Promise<Extraction | null> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(t.company)}/${encodeURIComponent(t.postingId)}`;
  const res = await safeFetch(deps, url);
  if (res.status !== 200) return null;
  const parsed = Posting.safeParse(safeJson(res.body));
  if (!parsed.success) return null;
  const p = parsed.data;
  const location = p.categories?.location ?? null;
  const sections = (p.lists ?? []).map((l) => ({
    heading: l.text,
    // Each list's content is <li> items.
    items: htmlToText(l.content)
      .split("\n")
      .map((x) => x.replace(/^- /, "")),
  }));
  const range = p.salaryRange;
  return {
    method: "ats_api",
    ats: "lever",
    atsPostingId: p.id,
    fields: {
      ...emptyFields(),
      title: p.text,
      company: t.company,
      location,
      remote: remoteFrom(p.workplaceType, location),
      salaryMin: wholeOrNull(range?.min),
      salaryMax: wholeOrNull(range?.max),
      salaryCurrency: range?.currency ?? null,
      salaryPeriod: range?.interval ? (PERIODS[range.interval] ?? null) : null,
      ...sortSections(sections),
      applyUrl: p.applyUrl ?? p.hostedUrl ?? null,
      ats: "lever",
      description: p.descriptionPlain?.trim() || null,
      postedAt: dateOrNull(p.createdAt),
    },
  };
}
