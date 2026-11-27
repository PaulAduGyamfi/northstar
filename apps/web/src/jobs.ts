import { z } from "zod";
import { safeHref } from "./handoffs";

// The jobs page (NS-130 slice 10): the API's answer and the plain words each job is shown in.
// Titles, companies and places come from job postings: the API has already cut them and removed
// hidden characters, and the page shows them as text only. Links are https only (the API drops
// any other), and the page checks again before rendering one.

const Job = z.object({
  // Its place in the queue, 1 first: the row key.
  rank: z.number(),
  title: z.string().nullable(),
  company: z.string().nullable(),
  location: z.string().nullable(),
  remote: z.enum(["remote", "hybrid", "onsite"]).nullable(),
  ageHours: z.number(),
  fit: z
    .object({
      score: z.number(),
      band: z.enum(["queue", "suggest", "skip"]),
      reason: z.string().nullable(),
      stretch: z.boolean(),
    })
    .nullable(),
  url: z.string().nullable(),
  // Why the score is what it is (slice 11): codes and counts, and unmatched must-haves in the
  // posting's own words. Optional so a page served before the API's slice 11 still reads.
  why: z
    .object({
      title: z.string(),
      levelMismatch: z.boolean(),
      pay: z.string(),
      place: z.string(),
      mustHave: z.object({ matched: z.number(), total: z.number() }),
      missing: z.array(z.string()),
      dealbreaker: z.boolean(),
    })
    .nullable()
    .optional(),
});
export type JobView = z.infer<typeof Job>;

export const JobsBody = z.object({
  role: z.string().nullable(),
  jobs: z.array(Job),
  more: z.boolean(),
});
export type JobsView = z.infer<typeof JobsBody>;

// How long ago it was posted, in the feed's own style ("Posted 12 min ago" is too fine here).
export function postedWords(hours: number): string {
  if (hours < 1) return "Posted in the last hour";
  if (hours < 24) return `Posted ${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "Posted yesterday" : `Posted ${days} days ago`;
}

// The MAT-003 band in Paul's words.
const BAND_WORDS = {
  queue: "in the queue",
  suggest: "suggested",
  skip: "below your bar",
} as const;

export function fitWords(fit: JobView["fit"]): string {
  if (fit === null) return "Not scored yet";
  const why = reasonWords(fit.reason);
  return `Fit ${fit.score} · ${BAND_WORDS[fit.band]}${why ? ` (${why})` : ""}${fit.stretch ? " · a stretch" : ""}`;
}

// The score's part names, as the scorer's `below_threshold:<part>` reasons name them.
// (COMPONENTS in packages/sources, fit/score.ts.)
const PART_WORDS: Record<string, string> = {
  title: "the title",
  mustHave: "must-have skills",
  niceToHave: "nice-to-have skills",
  preference: "your preferences",
};

// Why a job got its band (UX-014), from the scorer's reason code. "ok" needs no words; an unknown
// code is left out, never shown raw. `jobs why <id>` has the full evidence.
export function reasonWords(reason: string | null): string | null {
  if (reason === null || reason === "ok") return null;
  if (reason === "dealbreaker") return "matches one of your dealbreakers";
  if (reason === "below_comp_floor") return "pay is below your floor";
  if (reason === "no_evidence") return "nothing on your resume to match yet";
  const part = /^below_threshold:([A-Za-z]+)$/.exec(reason)?.[1];
  const word = part === undefined ? undefined : PART_WORDS[part];
  return word === undefined ? null : `weakest on ${word}`;
}

// Each check's code in words (packages/sources, fit/score.ts). The scorer answers "unknown" for
// several reasons (no title on the job or no target titles; pay unstated, in another currency or
// no floor set; no places set or none stated), so its words say only that it couldn't compare.
// An unknown code is left out, never shown raw.
const TITLE_WORDS: Record<string, string> = {
  exact: "Title: matches your target titles",
  partial: "Title: close to your target titles",
  none: "Title: not one of your target titles",
  unknown: "Title: can't check against your target titles",
};
const PAY_WORDS: Record<string, string> = {
  ok: "Pay: meets your floor",
  below: "Pay: below your floor",
  unknown: "Pay: can't compare with your floor",
};
const PLACE_WORDS: Record<string, string> = {
  ok: "Place: fits your locations",
  mismatch: "Place: outside your locations",
  unknown: "Place: can't check against your places",
};

// A job's why (UX-014) as lines under its score: each check, how many must-haves Paul's
// experience backs, which ones it doesn't show, and a dealbreaker without its words.
export function whyLines(why: JobView["why"]): string[] {
  if (why === null || why === undefined) return [];
  const lines: string[] = [];
  const title = TITLE_WORDS[why.title];
  if (title !== undefined) {
    lines.push(why.levelMismatch ? `${title}, at a level you didn't list` : title);
  }
  for (const line of [PAY_WORDS[why.pay], PLACE_WORDS[why.place]]) {
    if (line !== undefined) lines.push(line);
  }
  if (why.mustHave.total > 0) {
    lines.push(
      `Must-haves: ${why.mustHave.matched} of ${why.mustHave.total} backed by your experience`,
    );
  }
  if (why.missing.length > 0) lines.push(`Not shown in your experience: ${why.missing.join(", ")}`);
  if (why.dealbreaker) lines.push("Matches one of your dealbreakers");
  return lines;
}

const REMOTE_WORDS = { remote: "Remote", hybrid: "Hybrid", onsite: "On site" } as const;

// A link the page may render: https only, through the app's one check (safeHref).
export const safeLink = (url: string | null): string | null =>
  url === null ? null : safeHref(url);

export type JobRow = {
  key: string;
  title: string;
  where: string;
  posted: string;
  fit: string;
  why: string[];
  link: string | null;
};

// One job in words: what it is, where, how fresh and how well it fits.
export function jobRow(j: JobView): JobRow {
  const place = [j.company, j.location, j.remote === null ? null : REMOTE_WORDS[j.remote]].filter(
    (p): p is string => p !== null,
  );
  return {
    key: String(j.rank),
    title: j.title ?? "Untitled job",
    where: place.length === 0 ? "Company and place unknown" : place.join(" · "),
    posted: postedWords(j.ageHours),
    fit: fitWords(j.fit),
    why: whyLines(j.why),
    link: safeLink(j.url),
  };
}

// The heading for a filtered list, and the link from a direction on the Career DNA page.
export const roleHeading = (role: string) => `Jobs for ${role}`;
export const jobsForRole = (role: string) => `/jobs?role=${encodeURIComponent(role)}`;

// What the page says when there is nothing to list.
export const NO_JOBS =
  "No ready jobs yet. Watch a board with jobs watch add, or add one with jobs add <link>.";
export const NO_ROLE_JOBS = "No ready jobs in this role right now.";
export const MORE_JOBS = "Showing the first 100: the freshest and best-fitting.";
