import type { FitWhy, JobListItem, ScorableJob } from "@northstar/db";
import { ageHours, freshness, queueScore, roleFamily } from "@northstar/sources";
import { z } from "zod";
import { POSTING_TEXT_MAX, postingText } from "./career-directions.js";
import { type AnyEndpoint, endpoint } from "./endpoint.js";

// The jobs page (NS-130 slice 10, DNA-004, SRC-013), behind Paul's session. Read-only and plain
// code: ready jobs whose posting isn't known to be closed, in the queue's own order (freshness ×
// fit), each with what the page shows and no more. bin.ts wires the readers; tests fake them.
// Titles, companies and places come from postings (untrusted): they pass postingText. No
// description or atom leaves the API. Since slice 11 each job's `why` (UX-014) adds check codes,
// must-have counts and at most WHY_MISSING_MAX unmatched must-haves, in the posting's own words
// through postingText; never a matched requirement, an atom id or text, or Paul's dealbreaker.

// The page lists at most this many jobs: the freshest, best-fitting first.
export const JOBS_PAGE_MAX = 100;
// A job's why lists at most this many unmatched must-haves: the first ones the posting names.
export const WHY_MISSING_MAX = 5;

export type JobsPorts = {
  // Every job with its newest fit score (listJobs).
  jobs: () => Promise<
    Pick<
      JobListItem,
      | "id"
      | "status"
      | "title"
      | "company"
      | "location"
      | "postedAt"
      | "firstSeenAt"
      | "url"
      | "fit"
    >[]
  >;
  // Ready jobs whose posting isn't known to be closed (readScorableJobs), with their remote kind.
  open: () => Promise<Pick<ScorableJob, "id" | "remote">[]>;
  // Each listed job's newest score's components and evidence (readFitWhy), at most 100 ids.
  why: (jobIds: string[]) => Promise<Map<string, FitWhy>>;
  now: () => Date;
};

// A link the page may show: https only, so a stored `javascript:` or `http:` link never renders.
// Normalized (`href`), the same form the page's safeHref gives, and never with a user name or
// password in it.
export function postingLink(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.username === "" && u.password === "" ? u.href : null;
  } catch {
    return null;
  }
}

const Job = z.object({
  // Its place in the queue, 1 first: also the page's row key.
  rank: z.number().int(),
  title: z.string().nullable(),
  company: z.string().nullable(),
  location: z.string().nullable(),
  remote: z.enum(["remote", "hybrid", "onsite"]).nullable(),
  // Whole hours since it was posted, or first seen when the posting has no date.
  ageHours: z.number().int(),
  fit: z
    .object({
      score: z.number().int(),
      band: z.enum(["queue", "suggest", "skip"]),
      // The score's reason code ("ok", "dealbreaker", "below_threshold:mustHave"…; UX-014), or null
      // when it isn't one of those plain codes.
      reason: z.string().nullable(),
      stretch: z.boolean(),
    })
    .nullable(),
  url: z.string().nullable(),
  // Why the score is what it is (slice 11), or null when the job has no readable evidence.
  why: z
    .object({
      title: z.enum(["exact", "partial", "none", "unknown"]),
      // The job names a level Paul's seniority list doesn't include.
      levelMismatch: z.boolean(),
      pay: z.enum(["ok", "below", "unknown"]),
      place: z.enum(["ok", "mismatch", "unknown"]),
      mustHave: z.object({ matched: z.number().int(), total: z.number().int() }),
      missing: z.array(z.string()),
      dealbreaker: z.boolean(),
    })
    .nullable(),
});

const Output = z.object({ role: z.string().nullable(), jobs: z.array(Job), more: z.boolean() });

// Fit reasons are codes the scorer writes (packages/sources, fit/score.ts): only that shape passes.
const REASON = /^[a-z_]{1,40}(:[A-Za-z]{1,40})?$/;

const text = (s: string | null): string | null => (s === null ? null : postingText(s) || null);

// The stored evidence's shape (packages/sources, fit/score.ts Evidence), read leniently: extra
// fields (atom ids, model stamps) are dropped here and never reach the answer.
const Requirement = z.object({ requirement: z.string(), kind: z.enum(["must", "nice"]) });
const StoredEvidence = z.object({
  matched: z.array(Requirement),
  unmatched: z.array(Requirement),
  title: z.object({
    status: z.enum(["exact", "partial", "none", "unknown"]),
    levelMismatch: z.boolean(),
  }),
  pay: z.object({ status: z.enum(["ok", "below", "unknown"]) }),
  place: z.object({ status: z.enum(["ok", "mismatch", "unknown"]) }),
  dealbreaker: z.string().nullable(),
});

type Why = z.infer<typeof Job>["why"];

// One job's why, field by field from its stored evidence; null when it doesn't parse (an older
// score's shape), so the page shows the score without a why rather than a wrong one.
export function jobWhy(stored: FitWhy | undefined): Why {
  if (!stored) return null;
  const parsed = StoredEvidence.safeParse(stored.evidence);
  if (!parsed.success) return null;
  const e = parsed.data;
  const must = (r: { kind: string }) => r.kind === "must";
  const matched = e.matched.filter(must).length;
  const unmatched = e.unmatched.filter(must);
  return {
    title: e.title.status,
    levelMismatch: e.title.levelMismatch,
    pay: e.pay.status,
    place: e.place.status,
    mustHave: { matched, total: matched + unmatched.length },
    missing: unmatched
      .map((r) => postingText(r.requirement))
      .filter((r) => r !== "")
      .slice(0, WHY_MISSING_MAX),
    dealbreaker: e.dealbreaker !== null,
  };
}

export function jobsEndpoints(ports: JobsPorts): AnyEndpoint[] {
  const list = endpoint({
    method: "GET",
    path: "/jobs",
    auth: "session",
    // A direction's role, as /career-dna/directions shows it (postingText of a role family).
    input: z.object({ role: z.string().min(1).max(POSTING_TEXT_MAX).optional() }),
    output: Output,
    handler: async ({ role }) => {
      let all: Awaited<ReturnType<JobsPorts["jobs"]>>;
      let open: Awaited<ReturnType<JobsPorts["open"]>>;
      try {
        [all, open] = await Promise.all([ports.jobs(), ports.open()]);
      } catch {
        // Postgres down: the page says the jobs can't be read, never that there are none.
        return { ok: false, status: 503, error: "unavailable" };
      }
      const remoteOf = new Map(open.map((j) => [j.id, j.remote]));
      const now = ports.now();
      const ranked = all
        // Ready and not closed: the jobs the queue would show.
        .filter((j) => j.status === "ready" && remoteOf.has(j.id))
        // The same family text the directions show, so a direction's link finds its own jobs.
        .filter((j) => {
          if (role === undefined) return true;
          const family = roleFamily(j.title);
          return family !== null && postingText(family) === role;
        })
        .map((j) => {
          const age = ageHours(j.postedAt, j.firstSeenAt, now);
          return { j, age, order: queueScore(freshness(age), j.fit ? j.fit.score / 100 : null) };
        })
        // Best first; equal scores keep the freshest first.
        .sort((a, b) => b.order - a.order || a.age - b.age);
      const shown = ranked.slice(0, JOBS_PAGE_MAX);
      let whys = new Map<string, FitWhy>();
      try {
        whys = await ports.why(shown.filter(({ j }) => j.fit !== null).map(({ j }) => j.id));
      } catch {
        // The list still answers; each job shows its score without a why.
        whys = new Map();
      }
      return {
        ok: true,
        body: {
          role: role ?? null,
          jobs: shown.map(({ j, age }, i) => ({
            rank: i + 1,
            title: text(j.title),
            company: text(j.company),
            location: text(j.location),
            remote: remoteOf.get(j.id) ?? null,
            // A posting dated in the future counts as just posted.
            ageHours: Math.max(0, Math.floor(age)),
            fit: j.fit
              ? {
                  score: Math.round(j.fit.score),
                  band: j.fit.band,
                  reason: REASON.test(j.fit.reason) ? j.fit.reason : null,
                  stretch: j.fit.stretch,
                }
              : null,
            url: postingLink(j.url),
            why: j.fit ? jobWhy(whys.get(j.id)) : null,
          })),
          more: ranked.length > JOBS_PAGE_MAX,
        },
      };
    },
  });
  return [list];
}
