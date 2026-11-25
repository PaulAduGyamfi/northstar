import { z } from "zod";
import { type Extraction, emptyFields, htmlToText, remoteFrom } from "../extraction.js";
import { type FetchDeps, safeFetch } from "../fetch.js";
import { safeJson } from "./greenhouse.js";

// Workday's public job JSON (the `wday/cxs` endpoint its career sites load). Workday gives a
// relative posting age ("Posted 3 Days Ago"), not a date, so postedAt is worked out from it only
// when it's that exact shape.
const Posting = z.object({
  jobPostingInfo: z.object({
    title: z.string(),
    jobDescription: z.string().optional(),
    location: z.string().optional(),
    remoteType: z.string().optional(),
    postedOn: z.string().optional(),
    jobReqId: z.string().optional(),
    externalUrl: z.string().optional(),
  }),
  hiringOrganization: z.object({ name: z.string() }).optional(),
});

export async function workday(
  deps: FetchDeps & { now: () => Date },
  t: { host: string; tenant: string; site: string; path: string; postingId: string },
): Promise<Extraction | null> {
  const url = `https://${t.host}/wday/cxs/${encodeURIComponent(t.tenant)}/${encodeURIComponent(t.site)}/${t.path
    .split("/")
    .map((part) => encodeURIComponent(safeDecode(part)))
    .join("/")}`;
  const res = await safeFetch(deps, url);
  if (res.status !== 200) return null;
  const parsed = Posting.safeParse(safeJson(res.body));
  if (!parsed.success) return null;
  const p = parsed.data.jobPostingInfo;
  const location = p.location ?? null;
  return {
    method: "ats_api",
    ats: "workday",
    // Scoped by tenant, like the id detectAts reads from the URL.
    atsPostingId: p.jobReqId ? `${t.tenant}/${p.jobReqId}` : t.postingId,
    fields: {
      ...emptyFields(),
      title: p.title,
      company: parsed.data.hiringOrganization?.name ?? null,
      location,
      remote: remoteFrom(p.remoteType, location),
      applyUrl: p.externalUrl ?? null,
      ats: "workday",
      description: p.jobDescription ? htmlToText(p.jobDescription) : null,
      postedAt: postedOn(p.postedOn, deps.now()),
    },
  };
}

// "Posted Today", "Posted Yesterday", "Posted 3 Days Ago". "30+ Days Ago" is too vague: null.
export function postedOn(text: string | undefined, now: Date): Date | null {
  if (!text) return null;
  const day = 86_400_000;
  if (/^posted today$/i.test(text)) return now;
  if (/^posted yesterday$/i.test(text)) return new Date(now.getTime() - day);
  const n = /^posted (\d+) days? ago$/i.exec(text)?.[1];
  return n ? new Date(now.getTime() - Number(n) * day) : null;
}

// URL path parts arrive percent-encoded; decode before encoding again so %2C stays %2C.
function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}
