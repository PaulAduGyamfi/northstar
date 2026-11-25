import type { Ats } from "@northstar/db";

// Which ATS a posting URL belongs to, and the ids its public API needs. Plain URL parsing: no
// request is made to decide this.
export type AtsTarget =
  | { ats: "greenhouse"; board: string; postingId: string }
  | { ats: "lever"; company: string; postingId: string }
  | { ats: "ashby"; org: string; postingId: string }
  | { ats: "workday"; host: string; tenant: string; site: string; path: string; postingId: string };

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function detectAts(raw: string): AtsTarget | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);

  // boards.greenhouse.io/<board>/jobs/<id> and job-boards.greenhouse.io/<board>/jobs/<id>
  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") {
    const [board, jobs, id] = parts;
    if (board && jobs === "jobs" && id && SLUG.test(board) && /^\d+$/.test(id)) {
      return { ats: "greenhouse", board, postingId: id };
    }
    return null;
  }
  // jobs.lever.co/<company>/<uuid>[/apply]
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") {
    const [company, id] = parts;
    if (company && id && SLUG.test(company) && /^[0-9a-f-]{36}$/i.test(id)) {
      return { ats: "lever", company, postingId: id.toLowerCase() };
    }
    return null;
  }
  // jobs.ashbyhq.com/<org>/<uuid>[/application]
  if (host === "jobs.ashbyhq.com") {
    const [org, id] = parts;
    if (org && id && SLUG.test(org) && /^[0-9a-f-]{36}$/i.test(id)) {
      return { ats: "ashby", org, postingId: id.toLowerCase() };
    }
    return null;
  }
  // <tenant>.wd<N>.myworkdayjobs.com/[<locale>/]<site>/job/<location>/<title>_<reqId>
  const wd = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/.exec(host);
  if (wd?.[1]) {
    const start = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0] ?? "") ? 1 : 0;
    const site = parts[start];
    const jobAt = parts.indexOf("job", start + 1);
    const last = parts.at(-1) ?? "";
    if (site && SLUG.test(site) && jobAt === start + 1 && parts.length > jobAt + 1) {
      return {
        ats: "workday",
        host,
        tenant: wd[1],
        site,
        path: parts.slice(jobAt).join("/"),
        // Requisition ids are only unique within one company: scope them by tenant, or two
        // companies' R-00123 would be taken for the same posting (SRC-006).
        postingId: `${wd[1]}/${last.split("_").at(-1) ?? last}`,
      };
    }
  }
  return null;
}

export const atsOf = (t: AtsTarget): Ats => t.ats;
