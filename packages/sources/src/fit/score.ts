import { createHash } from "node:crypto";
import type { FitBand, PreferenceValues, ScorableJob, ScoringProfile } from "@northstar/db";
import { type Match, matchRequirements, namesTerm, type Unmatched } from "./match.js";
import { type ModelMatch, quoteInAtom } from "./model-match.js";

// The Fit Score (NS-116, MAT-001…003). Plain functions, no model: the same job, preferences and
// resume always give the same score, and every number has its evidence.

export const COMPONENTS = ["title", "mustHave", "niceToHave", "preference"] as const;
export type Component = (typeof COMPONENTS)[number];

// How much each component counts (spec). Unknown components are left out of the mean.
export const WEIGHTS: Record<Component, number> = {
  title: 25,
  mustHave: 40,
  niceToHave: 10,
  preference: 25,
};

// Pay periods to a year: 12 months, 2,080 working hours (40 h × 52 weeks).
const PER_YEAR = { year: 1, month: 12, hour: 2080 } as const;

// Levels a title or seniority can name, by the word used. "Sr"/"Jr" are the usual abbreviations.
const LEVELS: Record<string, string> = {
  intern: "intern",
  junior: "junior",
  jr: "junior",
  mid: "mid",
  senior: "senior",
  sr: "senior",
  staff: "staff",
  principal: "principal",
  lead: "lead",
  director: "director",
  head: "head",
  vp: "vp",
};

// Words too common to count as sharing a title.
const STOP = new Set(["and", "the", "for", "with", "of"]);

export type TitleCheck = {
  status: "exact" | "partial" | "none" | "unknown";
  // The job names a level Paul's seniority list doesn't include (the title fit is halved).
  levelMismatch: boolean;
};
export type PayCheck = { status: "ok" | "below" | "unknown"; yearly: number | null };
export type PlaceCheck = { status: "ok" | "mismatch" | "unknown" };

export type Evidence = {
  matched: Match[];
  unmatched: Unmatched[];
  title: TitleCheck;
  pay: PayCheck;
  place: PlaceCheck;
  // The dealbreaker the job names (Paul's own words), or null.
  dealbreaker: string | null;
};

export type FitResult = {
  score: number;
  band: FitBand;
  // A fixed code: ok, dealbreaker, below_comp_floor, below_threshold:<component>, no_evidence.
  reason: string;
  stretch: boolean;
  components: Record<Component, number | null>;
  evidence: Evidence;
};

const levelsIn = (text: string): Set<string> =>
  new Set(
    Object.entries(LEVELS)
      .filter(([word]) => namesTerm(text, word))
      .map(([, level]) => level),
  );

export function titleFit(job: ScorableJob, prefs: PreferenceValues): [number | null, TitleCheck] {
  const title = job.title ?? "";
  if (prefs.titles.length === 0 || title === "") {
    return [null, { status: "unknown", levelMismatch: false }];
  }
  const words = (s: string) =>
    s
      .toLowerCase()
      .split(/[^a-z0-9+#]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w));
  const titleWords = new Set(words(title));
  const status = prefs.titles.some((t) => namesTerm(title, t))
    ? "exact"
    : prefs.titles.some((t) => words(t).some((w) => titleWords.has(w)))
      ? "partial"
      : "none";
  const base = { exact: 1, partial: 0.5, none: 0 }[status];
  // Halved when the job names a level and none of them is one Paul wants.
  const named = levelsIn(`${title} ${job.seniority ?? ""}`);
  const wanted = new Set(prefs.seniority.flatMap((s) => [...levelsIn(s)]));
  const levelMismatch = named.size > 0 && wanted.size > 0 && ![...named].some((l) => wanted.has(l));
  return [levelMismatch ? base / 2 : base, { status, levelMismatch }];
}

const coverage = (matched: Match[], unmatched: Unmatched[], kind: "must" | "nice") => {
  const hit = matched.filter((m) => m.kind === kind).length;
  const total = hit + unmatched.filter((u) => u.kind === kind).length;
  return total === 0 ? null : hit / total;
};

// The top of the posted range as yearly pay in Paul's currency, checked against his floor.
export function payCheck(job: ScorableJob, prefs: PreferenceValues): PayCheck {
  const top = job.salaryMax ?? job.salaryMin;
  const sameCurrency = job.salaryCurrency?.toUpperCase() === prefs.currency;
  if (top === null || job.salaryPeriod === null || !sameCurrency) {
    return { status: "unknown", yearly: null };
  }
  const yearly = top * PER_YEAR[job.salaryPeriod];
  if (prefs.compFloor === null) return { status: "unknown", yearly };
  return { status: yearly >= prefs.compFloor ? "ok" : "below", yearly };
}

export function placeCheck(job: ScorableJob, prefs: PreferenceValues): PlaceCheck {
  if (prefs.remote.length === 0 && prefs.locations.length === 0) return { status: "unknown" };
  if (job.remote !== null && prefs.remote.includes(job.remote)) return { status: "ok" };
  const location = job.location ?? "";
  if (prefs.locations.some((l) => namesTerm(location, l))) return { status: "ok" };
  if (job.remote === null && job.location === null) return { status: "unknown" };
  return { status: "mismatch" };
}

// The first dealbreaker the job names as a whole phrase anywhere in its text.
export function dealbreakerIn(job: ScorableJob, prefs: PreferenceValues): string | null {
  const text = [job.title, job.description, ...job.requirements, ...job.niceToHaves]
    .filter((s): s is string => s !== null)
    .join("\n");
  return prefs.dealbreakers.find((d) => namesTerm(text, d)) ?? null;
}

const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

// `assisted`: model matches that passed checkJobMatches (NS-138). Each moves its requirement
// from unmatched to matched; one for a requirement the rules already matched, or the job doesn't
// have, changes nothing. The rules always run first and stay the floor.
export function scoreJob(
  job: ScorableJob,
  prefs: PreferenceValues,
  profile: ScoringProfile,
  assisted: readonly ModelMatch[] = [],
): FitResult {
  const { matched, unmatched: ruleUnmatched } = matchRequirements(
    [
      ...job.requirements.map((text) => ({ text, kind: "must" as const })),
      ...job.niceToHaves.map((text) => ({ text, kind: "nice" as const })),
    ],
    profile,
  );
  const unmatched: Unmatched[] = [];
  for (const u of ruleUnmatched) {
    // Re-checked here against this profile, whoever built the list: an unknown atom or a quote
    // that isn't in it leaves the requirement unmatched.
    const m = assisted.find(
      (a) =>
        a.requirement === u.requirement &&
        profile.atoms.some((atom) => atom.id === a.atomId && quoteInAtom(atom, a.quote)),
    );
    if (m) {
      matched.push({
        requirement: u.requirement,
        kind: u.kind,
        atomId: m.atomId,
        term: m.quote,
        by: "model",
        ...(m.stamp ? { stamp: m.stamp } : {}),
      });
    } else unmatched.push(u);
  }
  const [title, titleEvidence] = titleFit(job, prefs);
  const pay = payCheck(job, prefs);
  const place = placeCheck(job, prefs);
  const prefScores = [
    pay.status === "unknown" ? null : pay.status === "ok" ? 1 : 0,
    place.status === "unknown" ? null : place.status === "ok" ? 1 : 0,
  ].filter((x): x is number => x !== null);
  const components: Record<Component, number | null> = {
    title,
    mustHave: coverage(matched, unmatched, "must"),
    niceToHave: coverage(matched, unmatched, "nice"),
    preference: mean(prefScores),
  };
  const known = COMPONENTS.filter((c) => components[c] !== null);
  const weight = known.reduce((s, c) => s + WEIGHTS[c], 0);
  const score =
    known.length === 0
      ? 50
      : Math.round(
          (100 * known.reduce((s, c) => s + WEIGHTS[c] * (components[c] ?? 0), 0)) / weight,
        );
  const must = components.mustHave;
  const stretch = must !== null && must >= 0.5 && must < 0.75;
  const dealbreaker = dealbreakerIn(job, prefs);
  const evidence: Evidence = { matched, unmatched, title: titleEvidence, pay, place, dealbreaker };
  const [band, reason] = bandFor(score, components, known, prefs, dealbreaker, pay);
  return { score, band, reason, stretch, components, evidence };
}

function bandFor(
  score: number,
  components: Record<Component, number | null>,
  known: Component[],
  prefs: PreferenceValues,
  dealbreaker: string | null,
  pay: PayCheck,
): [FitBand, string] {
  if (dealbreaker !== null) return ["skip", "dealbreaker"];
  if (pay.status === "below") return ["skip", "below_comp_floor"];
  // Nothing to judge by: Paul should look rather than have it skipped.
  if (known.length === 0) return ["suggest", "no_evidence"];
  if (score >= prefs.queueAt) return ["queue", "ok"];
  if (score >= prefs.suggestAt) return ["suggest", "ok"];
  // The weakest known component explains the skip (first in COMPONENTS order on a tie).
  const weakest = known.reduce((a, b) => ((components[b] ?? 0) < (components[a] ?? 0) ? b : a));
  return ["skip", `below_threshold:${weakest}`];
}

// sha256 of the fields scoring reads, in a fixed order: a job edit gives a new key, so the job
// is scored again (and an unchanged job never is).
export function jobFingerprint(job: ScorableJob): string {
  const { id: _id, ...fields } = job;
  const ordered = Object.keys(fields)
    .sort()
    .map((k) => [k, fields[k as keyof typeof fields]]);
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}
