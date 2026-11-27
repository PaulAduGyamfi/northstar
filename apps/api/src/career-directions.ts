import type { ScoringProfile } from "@northstar/db";
import type { GrowthTrack } from "@northstar/domain";
import { type CareerDnaDimension, evidenceGaps } from "@northstar/profile";
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

// Control characters and invisible formatting characters (U+200B, U+202E…): a posting could use
// them to make a line read as something else. Line and paragraph separators are listed too,
// although the whitespace step below already turns them into spaces.
const HIDDEN = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

// Posting text as the page may show it: hidden characters gone, spaces collapsed, cut to
// POSTING_TEXT_MAX characters (whole code points, so no half of a pair is left).
export function postingText(text: string): string {
  // Tabs and line breaks become spaces first, so removing hidden characters never joins words.
  const clean = text.replace(/\s+/g, " ").replace(HIDDEN, "").replace(/\s+/g, " ").trim();
  return Array.from(clean).slice(0, POSTING_TEXT_MAX).join("");
}

const Gap = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("dimension"),
    label: z.string(),
    band: z.enum(["not_enough", "low"]),
    evidenceCount: z.number().int(),
  }),
  z.object({
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
            hasReport: dimensions.length > 0,
            // Field by field: matched atom ids and fresh job ids become counts.
            list: directions.map((d) => ({
              role: postingText(d.role),
              jobCount: d.jobCount,
              coverage: d.coverage,
              matchedAtoms: d.evidence.length,
              gaps: d.gaps.map((g) => ({ requirement: postingText(g.requirement), jobs: g.jobs })),
              freshJobs: d.freshJobIds.length,
            })),
            gaps: gaps.map((g) =>
              g.kind === "dimension"
                ? { kind: g.kind, label: g.label, band: g.band, evidenceCount: g.evidenceCount }
                : {
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
