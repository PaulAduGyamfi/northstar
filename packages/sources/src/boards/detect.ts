import type { WatchAts } from "@northstar/db";

// A company's whole job board, as Paul gives it to `jobs watch add` (SRC-003). Plain URL parsing:
// no request is made to decide this.
// A Workday board is `<tenant>.wd<N>/<site>` (NS-260): the tenant and data center pick the host.
export type BoardTarget = { ats: WatchAts; board: string; url: string };

// <tenant>.wd<N>.myworkdayjobs.com, the tenant as Workday's own posting links name it.
const WORKDAY_HOST = /^([a-z0-9-]{1,63})\.(wd\d{1,3})\.myworkdayjobs\.com$/;
// Workday prefixes a career site's path with a locale on some links (`en-US`).
const LOCALE = /^[a-z]{2}-[A-Z]{2}$/;

// Board ids are path slugs; anything else (dots-only, encoded slashes) is refused.
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// ATSs whose board names are lower case at the source, so a typed `Globex` is the same board as
// `globex`. Unverified for the others, so their names are kept exactly as typed.
const CASE_FOLDED = new Set<BoardTarget["ats"]>(["greenhouse", "lever"]);

// Each ATS's board host, and the canonical host the stored URL uses.
const HOSTS: Record<string, { ats: BoardTarget["ats"]; canonical: string }> = {
  "boards.greenhouse.io": { ats: "greenhouse", canonical: "boards.greenhouse.io" },
  "job-boards.greenhouse.io": { ats: "greenhouse", canonical: "boards.greenhouse.io" },
  "jobs.lever.co": { ats: "lever", canonical: "jobs.lever.co" },
  "jobs.ashbyhq.com": { ats: "ashby", canonical: "jobs.ashbyhq.com" },
  "jobs.smartrecruiters.com": { ats: "smartrecruiters", canonical: "jobs.smartrecruiters.com" },
  "careers.smartrecruiters.com": { ats: "smartrecruiters", canonical: "jobs.smartrecruiters.com" },
  "apply.workable.com": { ats: "workable", canonical: "apply.workable.com" },
};

export function detectBoard(raw: string): BoardTarget | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  // The monthly HN "Who is hiring?" thread (NS-282): exactly the whoishiring account's page.
  if (u.hostname.toLowerCase() === "news.ycombinator.com") return hnBoard(u);
  const workday = workdayBoard(u);
  if (workday !== undefined) return workday;
  const host = HOSTS[u.hostname.toLowerCase()];
  if (!host) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  // Exactly one path part: a longer path is a single posting (that's `jobs add`).
  const [typed] = parts;
  if (parts.length !== 1 || !typed || !SLUG.test(typed)) return null;
  const board = CASE_FOLDED.has(host.ats) ? typed.toLowerCase() : typed;
  return { ats: host.ats, board, url: `https://${host.canonical}/${board}` };
}

// A Workday career site: exactly its site name, after an optional locale (a longer path is a
// posting, which is `jobs add`). Undefined when the host isn't Workday's, null when it is but the
// path isn't a site.
function workdayBoard(u: URL): BoardTarget | null | undefined {
  const m = WORKDAY_HOST.exec(u.hostname.toLowerCase());
  if (!m) return undefined;
  const [, tenant, dc] = m;
  const parts = u.pathname.split("/").filter(Boolean);
  const path = parts[0] && LOCALE.test(parts[0]) ? parts.slice(1) : parts;
  const [site] = path;
  if (!tenant || !dc || path.length !== 1 || !site || !SLUG.test(site)) return null;
  return {
    ats: "workday",
    board: `${tenant}.${dc}/${site}`,
    url: `https://${tenant}.${dc}.myworkdayjobs.com/${site}`,
  };
}

// Only `news.ycombinator.com/submitted?id=whoishiring`: the account that posts the monthly thread.
// Any other HN page (a story, a user, the front page) is not a watch.
function hnBoard(u: URL): BoardTarget | null {
  const id = u.searchParams.get("id");
  if (
    u.pathname !== "/submitted" ||
    id !== "whoishiring" ||
    [...u.searchParams.keys()].length !== 1
  ) {
    return null;
  }
  return {
    ats: "hn_hiring",
    board: "whoishiring",
    url: "https://news.ycombinator.com/submitted?id=whoishiring",
  };
}
