import type { ScoringProfile } from "@northstar/db";
import type { GrowthTrack } from "@northstar/domain";
import { type CareerDnaDimension, evidenceGaps, INVISIBLE_IN_WORK } from "@northstar/profile";
import { careerDirections, type DirectionJob } from "@northstar/sources";
import { z } from "zod";
import { type AnyEndpoint, endpoint } from "./endpoint.js";

// Directions and evidence gaps on the Career DNA page (NS-130 slice 9, DNA-004/006), behind
// Paul's session. Read-only and plain code: the Fit Score's own matcher over ready, open jobs
// (careerDirections, packages/sources), then evidenceGaps (packages/profile) over the newest
// report's dimensions, those directions and Paul's growth tracks. bin.ts wires the readers; tests
// fake them. Atom ids, job ids and atom text never leave the API: the page shows counts.

// Role and requirement text comes from job postings (untrusted). It is only shown back, at most
// this many characters.
export const POSTING_TEXT_MAX = 200;

// A report dimension as the gaps need it: its rubric name, band and how much evidence backs it.
export type DirectionDimension = Pick<
  CareerDnaDimension,
  "key" | "label" | "band" | "points" | "evidenceCount"
>;

export type DirectionsPorts = {
  // The current resume import's atoms and skills; null before any import.
  profile: () => Promise<ScoringProfile | null>;
  // Ready jobs whose posting isn't known to be closed, each dated by its posting or first seen.
  jobs: () => Promise<DirectionJob[]>;
  // The newest stored report's dimensions the current rubric still names; [] before a report.
  dimensions: () => Promise<DirectionDimension[]>;
  // Paul's current growth tracks; [] before his first tracks file.
  tracks: () => Promise<Pick<GrowthTrack, "name" | "status">[]>;
  now: () => Date;
};

// What directions read from a job: its id, title and must-haves, dated by its posting, or by when
// it was first seen when the posting has none. `listed` gives the dates (listJobs); a scorable job
// missing from it gets no date, so it never counts as fresh.
export function directionJobs(
  scorable: { id: string; title: string | null; requirements: string[] }[],
  listed: { id: string; postedAt: Date | null; firstSeenAt: Date }[],
): DirectionJob[] {
  const dated = new Map(listed.map((j) => [j.id, j.postedAt ?? j.firstSeenAt]));
  return scorable.map((j) => ({
    id: j.id,
    title: j.title,
    requirements: j.requirements,
    postedAt: dated.get(j.id) ?? null,
  }));
}

// Control characters and invisible formatting characters (U+200B, U+202E…): a posting could use
// them to make a line read as something else. Line and paragraph separators are listed too,
// although the whitespace step below already turns them into spaces.
// Since NS-130 slice 12 also the blank-looking characters that aren't formatting ones, through
// the very pattern parseIndependentWork refuses (packages/profile, INVISIBLE_IN_WORK: the Hangul
// fillers, the braille blank, the combining grapheme joiner and the variation selectors), so a
// posting can't pad a line with characters that look like nothing, and the two lists can't drift.
const HIDDEN = new RegExp(`[\\p{Cc}\\u2028\\u2029]|${INVISIBLE_IN_WORK.source}`, "gu");
// Of those, the ones that take no space (controls, formatting characters, combining marks such as
// the joiner and the selectors) are removed; the rest (the Hangul fillers and the braille blank)
// show as a blank with width, so they become a space and never join the words beside them.
const ZERO_WIDTH = /^[\p{Cc}\p{Cf}\p{M}]$/u;
const unhide = (ch: string): string => (ZERO_WIDTH.test(ch) ? "" : " ");

// Posting text as the page may show it: hidden characters gone, spaces collapsed, cut to
// POSTING_TEXT_MAX characters (whole code points, so no half of a pair is left).
export function postingText(text: string): string {
  // Tabs and line breaks become spaces first, so removing hidden characters never joins words.
  const clean = text.replace(/\s+/g, " ").replace(HIDDEN, unhide).replace(/\s+/g, " ").trim();
  return Array.from(clean).slice(0, POSTING_TEXT_MAX).join("");
}

// Every suggestion carries its place in the list (1 first), the page's row key.
const Gap = z.discriminatedUnion("kind", [
  z.object({
    rank: z.number().int(),
    kind: z.literal("dimension"),
    label: z.string(),
    band: z.enum(["not_enough", "low"]),
    evidenceCount: z.number().int(),
  }),
  z.object({
    rank: z.number().int(),
    kind: z.literal("requirement"),
    requirement: z.string(),
    role: z.string(),
    jobs: z.number().int(),
    share: z.number().int(),
  }),
]);

const Output = z.object({
  directions: z
    .object({
      // False before the first Career DNA report: dimension gaps need one.
      hasReport: z.boolean(),
      list: z.array(
        z.object({
          // 1 for the best-covered direction: its place in the list, also the page's row key (posting
          // text can look the same after cleaning, so it can't be the key).
          rank: z.number().int(),
          role: z.string(),
          jobCount: z.number().int(),
          coverage: z.number().int().nullable(),
          matchedAtoms: z.number().int(),
          gaps: z.array(z.object({ requirement: z.string(), jobs: z.number().int() })),
          freshJobs: z.number().int(),
        }),
      ),
      gaps: z.array(Gap),
    })
    .nullable(),
});

export function careerDirectionsEndpoints(ports: DirectionsPorts): AnyEndpoint[] {
  const read = endpoint({
    method: "GET",
    path: "/career-dna/directions",
    auth: "session",
    input: z.object({}),
    output: Output,
    handler: async () => {
      let profile: ScoringProfile | null;
      let jobs: DirectionJob[];
      let dimensions: DirectionDimension[];
      let tracks: Pick<GrowthTrack, "name" | "status">[];
      try {
        profile = await ports.profile();
        if (profile === null) return { ok: true, body: { directions: null } };
        [jobs, dimensions, tracks] = await Promise.all([
          ports.jobs(),
          ports.dimensions(),
          ports.tracks(),
        ]);
      } catch {
        // Postgres down: the page says these can't be read, never that there are none.
        return { ok: false, status: 503, error: "unavailable" };
      }
      const directions = careerDirections(jobs, profile, ports.now());
      // evidenceGaps reads only key, label, band and count; the cites stay in the stored report.
      const gaps = evidenceGaps(
        dimensions.map((d) => ({ ...d, cites: [] })),
        directions,
        tracks,
      );
      return {
        ok: true,
        body: {
          directions: {
            // A stored report whose keys the current rubric no longer names counts as none: its
            // dimensions can't be worded, so they can't be suggested from either.
            hasReport: dimensions.length > 0,
            // Field by field: matched atom ids and fresh job ids become counts.
            list: directions.map((d, i) => ({
              rank: i + 1,
              role: postingText(d.role),
              jobCount: d.jobCount,
              coverage: d.coverage,
              matchedAtoms: d.evidence.length,
              gaps: d.gaps.map((g) => ({ requirement: postingText(g.requirement), jobs: g.jobs })),
              freshJobs: d.freshJobIds.length,
            })),
            gaps: gaps.map((g, i) =>
              g.kind === "dimension"
                ? {
                    rank: i + 1,
                    kind: g.kind,
                    label: g.label,
                    band: g.band,
                    evidenceCount: g.evidenceCount,
                  }
                : {
                    rank: i + 1,
                    kind: g.kind,
                    requirement: postingText(g.requirement),
                    role: postingText(g.role),
                    jobs: g.jobs,
                    share: g.share,
                  },
            ),
          },
        },
      };
    },
  });
  return [read];
}
