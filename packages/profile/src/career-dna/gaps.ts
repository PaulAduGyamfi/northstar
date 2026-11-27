import type { GrowthTrack } from "@northstar/domain";
import { hasWhole, normalize } from "../validate.js";
import type { DimensionScore } from "./score.js";

// Evidence gaps (NS-130 slice 3, DNA-006): where Paul's proof is thin, suggest a proof-of-work
// track (GRW-008/009). Plain code. It only suggests: nothing writes a track, Paul adds one to his
// own tracks file. Requirement text comes from job postings (untrusted) and is only shown back.

// A requirement gap counts when at least this many of a direction's jobs ask for it…
export const GAP_MIN_JOBS = 2;
// …and they are at least this share of the direction's jobs, in percent.
export const GAP_MIN_SHARE = 25;
// Only this much of a requirement is compared with track names: postings are unbounded.
const REQUIREMENT_MAX = 200;

// What evidenceGaps reads from a career direction (packages/sources' careerDirections, which
// passes on only each direction's top gaps).
export type GapDirection = {
  role: string;
  jobCount: number;
  gaps: { requirement: string; jobs: number }[];
};

export type EvidenceGap =
  | {
      kind: "dimension";
      dimension: string;
      label: string;
      band: "not_enough" | "low";
      evidenceCount: number;
      suggestion: string;
    }
  | {
      kind: "requirement";
      requirement: string;
      // The direction where it is asked for most.
      role: string;
      jobs: number;
      share: number;
      suggestion: string;
    };

type TrackRef = Pick<GrowthTrack, "name" | "status">;

// A track Paul is working on or has planned names this gap (either inside the other, as whole
// words, ignoring case). "AWS" is covered by "AWS Solutions Architect"; "Experience with AWS" by
// a track named "AWS". A finished or paused track doesn't count: the gap is still open.
function covered(text: string, tracks: TrackRef[]): boolean {
  const t = normalize(text.slice(0, REQUIREMENT_MAX)).toLowerCase();
  return tracks
    .filter((k) => k.status === "active" || k.status === "backlogged")
    .some((k) => {
      const name = normalize(k.name).toLowerCase();
      return hasWhole(t, name) || hasWhole(name, t);
    });
}

const key = (text: string): string => normalize(text).toLowerCase();

export function evidenceGaps(
  dimensions: DimensionScore[],
  directions: GapDirection[],
  tracks: TrackRef[],
): EvidenceGap[] {
  const out: EvidenceGap[] = [];
  // Dimensions first, in rubric order: thin proof of a strength Paul claims.
  for (const d of dimensions) {
    if (d.band !== "not_enough" && d.band !== "low") continue;
    if (covered(d.label, tracks)) continue;
    out.push({
      kind: "dimension",
      dimension: d.key,
      label: d.label,
      band: d.band,
      evidenceCount: d.evidenceCount,
      suggestion: `Build proof for ${d.label}`,
    });
  }
  // Then requirement gaps, once each, from the direction where they weigh most.
  // Shares are compared exactly (49 of 200 is under 25 %); only the reported share is rounded.
  const best = new Map<
    string,
    { gap: Extract<EvidenceGap, { kind: "requirement" }>; exact: number }
  >();
  for (const dir of directions) {
    if (dir.jobCount === 0) continue;
    for (const g of dir.gaps) {
      if (g.jobs < GAP_MIN_JOBS || g.jobs * 100 < GAP_MIN_SHARE * dir.jobCount) continue;
      const exact = g.jobs / dir.jobCount;
      const k = key(g.requirement);
      const seen = best.get(k);
      if (seen && (seen.exact > exact || (seen.exact === exact && seen.gap.jobs >= g.jobs))) {
        continue;
      }
      best.set(k, {
        exact,
        gap: {
          kind: "requirement",
          requirement: g.requirement,
          role: dir.role,
          jobs: g.jobs,
          share: Math.round(exact * 100),
          suggestion: `Build proof for ${g.requirement}`,
        },
      });
    }
  }
  const requirements = [...best.values()]
    .filter((b) => !covered(b.gap.requirement, tracks))
    // Array.sort is stable: equal ones keep the order they were first seen in.
    .sort((a, b) => b.exact - a.exact || b.gap.jobs - a.gap.jobs)
    .map((b) => b.gap);
  return [...out, ...requirements];
}
