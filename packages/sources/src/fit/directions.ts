import type { ScoringProfile } from "@northstar/db";
import { matchRequirements } from "./match.js";

// Career directions (NS-130 slice 2, DNA-004): the kinds of role open now, ranked by how much
// of what those jobs ask for Paul's work already proves, with the evidence, the main gaps and
// the fresh jobs to go to. Plain code, using the Fit Score's own matcher, so a direction's
// coverage agrees with the scores Paul already sees. Requirement text comes from job postings
// (untrusted): it is only counted and shown back, never acted on.

// A family needs this many jobs: one posting is not a direction.
export const MIN_DIRECTION_JOBS = 2;
// A job posted (or first seen) within this many days counts as fresh.
export const FRESH_DIRECTION_DAYS = 7;
// The most frequent unmatched must-haves shown per direction.
export const DIRECTION_GAPS = 5;

export type DirectionJob = {
  id: string;
  title: string | null;
  // Its must-have requirements.
  requirements: string[];
  // When it was posted, or first seen when the posting gives no date; null when neither.
  postedAt: Date | null;
};

export type CareerDirection = {
  role: string;
  jobCount: number;
  // Matched must-haves over all its must-haves, a whole percent; null when it has none.
  coverage: number | null;
  // Each matched atom with how many requirements it met, most first.
  evidence: { atomId: string; requirements: number }[];
  // The most frequent unmatched must-haves, worded as first seen.
  gaps: { requirement: string; jobs: number }[];
  // Fresh jobs, freshest first.
  freshJobIds: string[];
};

const SENIORITY = new Set(["senior", "sr", "junior", "jr", "staff", "principal", "lead"]);
const LEVELS = new Set(["i", "ii", "iii", "iv"]);

// Titles come from postings (untrusted, unbounded): only this much is read, which keeps the
// word clean-up below fast on a hostile title. No real role name is longer.
const TITLE_MAX = 200;

// The role family a title belongs to: lower-cased, cut at a qualifier, seniority words dropped.
export function roleFamily(title: string | null): string | null {
  if (title === null) return null;
  // A qualifier starts at a comma, a spaced hyphen, en or em dash, a spaced bar or a bracket.
  const head =
    title
      .slice(0, TITLE_MAX)
      .toLowerCase()
      .split(/,| [-–—] | \| |\(/)[0] ?? "";
  const words = head
    .split(/\s+/)
    // "Sr." and "Senior," are the same word.
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}+#]+$/gu, ""))
    .filter((w) => w !== "" && !SENIORITY.has(w) && !LEVELS.has(w));
  return words.length === 0 ? null : words.join(" ");
}

// The same requirement worded with other case or spacing counts once.
const gapKey = (text: string): string => text.trim().replace(/\s+/g, " ").toLowerCase();

type Family = {
  jobs: DirectionJob[];
  total: number;
  matched: number;
  atoms: Map<string, number>;
  // Insertion order is first seen, which breaks ties between gaps.
  gaps: Map<string, { requirement: string; jobs: number }>;
};

export function careerDirections(
  jobs: DirectionJob[],
  profile: ScoringProfile,
  now: Date,
): CareerDirection[] {
  const families = new Map<string, Family>();
  for (const j of jobs) {
    const role = roleFamily(j.title);
    if (role === null) continue;
    const f: Family = families.get(role) ?? {
      jobs: [],
      total: 0,
      matched: 0,
      atoms: new Map(),
      gaps: new Map(),
    };
    families.set(role, f);
    f.jobs.push(j);
    const requirements = j.requirements.map((text) => ({ text, kind: "must" as const }));
    const { matched, unmatched } = matchRequirements(requirements, profile);
    f.total += requirements.length;
    f.matched += matched.length;
    for (const m of matched) f.atoms.set(m.atomId, (f.atoms.get(m.atomId) ?? 0) + 1);
    // A requirement a job lists twice counts twice in coverage (it is two of the job's lines)
    // but is one gap for that job: gaps count jobs, not lines.
    const seen = new Set<string>();
    for (const u of unmatched) {
      const key = gapKey(u.requirement);
      if (key === "" || seen.has(key)) continue;
      seen.add(key);
      const gap = f.gaps.get(key) ?? { requirement: u.requirement.trim(), jobs: 0 };
      gap.jobs += 1;
      f.gaps.set(key, gap);
    }
  }

  const freshAfter = now.getTime() - FRESH_DIRECTION_DAYS * 86_400_000;
  const directions: CareerDirection[] = [];
  for (const [role, f] of families) {
    if (f.jobs.length < MIN_DIRECTION_JOBS) continue;
    const fresh = f.jobs
      .filter((j): j is DirectionJob & { postedAt: Date } => j.postedAt !== null)
      // A date after now is bad data, not a fresh job.
      .filter((j) => j.postedAt.getTime() >= freshAfter && j.postedAt <= now)
      .sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime());
    directions.push({
      role,
      jobCount: f.jobs.length,
      coverage: f.total === 0 ? null : Math.round((f.matched / f.total) * 100),
      // Array.sort is stable, so equal counts keep first-seen order.
      evidence: [...f.atoms]
        .map(([atomId, requirements]) => ({ atomId, requirements }))
        .sort((a, b) => b.requirements - a.requirements),
      gaps: [...f.gaps.values()].sort((a, b) => b.jobs - a.jobs).slice(0, DIRECTION_GAPS),
      freshJobIds: fresh.map((j) => j.id),
    });
  }
  return directions.sort(
    (a, b) =>
      (b.coverage ?? -1) - (a.coverage ?? -1) ||
      b.freshJobIds.length - a.freshJobIds.length ||
      b.jobCount - a.jobCount ||
      // Plain code-unit order, the same on every machine (localeCompare depends on the locale).
      (a.role < b.role ? -1 : a.role > b.role ? 1 : 0),
  );
}
