import { z } from "zod";
import { dateOrNull, type Extraction, emptyFields, htmlToText, remoteFrom } from "../extraction.js";
import { type FetchDeps, safeFetch } from "../fetch.js";

// Greenhouse's public job-board API (boards-api.greenhouse.io): the same JSON its hosted boards
// use. Content is HTML with its entities escaped once more.
const Posting = z.object({
  id: z.number(),
  title: z.string(),
  company_name: z.string().optional(),
  absolute_url: z.string().optional(),
  location: z.object({ name: z.string() }).optional(),
  content: z.string().optional(),
  first_published: z.string().optional(),
  updated_at: z.string().optional(),
  pay_input_ranges: z
    .array(z.object({ min_cents: z.number(), max_cents: z.number(), currency_type: z.string() }))
    .optional(),
});

export async function greenhouse(
  deps: FetchDeps,
  t: { board: string; postingId: string },
): Promise<Extraction | null> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t.board)}/jobs/${encodeURIComponent(t.postingId)}?pay_transparency=true`;
  const res = await safeFetch(deps, url);
  if (res.status !== 200) return null;
  const parsed = Posting.safeParse(safeJson(res.body));
  if (!parsed.success) return null;
  const p = parsed.data;
  const pay = p.pay_input_ranges?.[0];
  const location = p.location?.name ?? null;
  return {
    method: "ats_api",
    ats: "greenhouse",
    atsPostingId: String(p.id),
    fields: {
      ...emptyFields(),
      title: p.title,
      company: p.company_name ?? null,
      location,
      remote: remoteFrom(location),
      salaryMin: pay ? Math.round(pay.min_cents / 100) : null,
      salaryMax: pay ? Math.round(pay.max_cents / 100) : null,
      salaryCurrency: pay?.currency_type ?? null,
      // Greenhouse pay ranges are annual unless stated otherwise.
      salaryPeriod: pay ? "year" : null,
      applyUrl: p.absolute_url ?? null,
      ats: "greenhouse",
      description: p.content ? htmlToText(htmlToText(p.content)) : null,
      postedAt: dateOrNull(p.first_published ?? p.updated_at),
    },
  };
}

export function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
