import type { WatchAts } from "@northstar/db";

// A company's whole job board, as Paul gives it to `jobs watch add` (SRC-003). Plain URL parsing:
// no request is made to decide this.
export type BoardTarget = { ats: Exclude<WatchAts, "workday">; board: string; url: string };

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
  const host = HOSTS[u.hostname.toLowerCase()];
  if (!host) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  // Exactly one path part: a longer path is a single posting (that's `jobs add`).
  const [typed] = parts;
  if (parts.length !== 1 || !typed || !SLUG.test(typed)) return null;
  const board = CASE_FOLDED.has(host.ats) ? typed.toLowerCase() : typed;
  return { ats: host.ats, board, url: `https://${host.canonical}/${board}` };
}
