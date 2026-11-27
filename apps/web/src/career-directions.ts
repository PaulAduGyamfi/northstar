import { z } from "zod";

// Directions and evidence gaps on the Career DNA page (NS-130 slice 9, DNA-004/006): the API's
// answer and the plain words it is shown in. Role and requirement text comes from job postings:
// the API has already cut it and removed hidden characters, and the page shows it as text only.

const Gap = z.discriminatedUnion("kind", [
  z.object({
    // Its place in the list, 1 first: the row key.
    rank: z.number(),
    kind: z.literal("dimension"),
    label: z.string(),
    band: z.enum(["not_enough", "low"]),
    evidenceCount: z.number(),
  }),
  z.object({
    rank: z.number(),
    kind: z.literal("requirement"),
    requirement: z.string(),
    role: z.string(),
    jobs: z.number(),
    share: z.number(),
  }),
]);
export type ProofGap = z.infer<typeof Gap>;

const Direction = z.object({
  // Its place in the list, 1 first: the row key, since posting text can look the same twice.
  rank: z.number(),
  role: z.string(),
  jobCount: z.number(),
  // Matched must-haves over all of them, a whole percent; null when its jobs list none.
  coverage: z.number().nullable(),
  matchedAtoms: z.number(),
  gaps: z.array(z.object({ requirement: z.string(), jobs: z.number() })),
  freshJobs: z.number(),
});
export type CareerDirectionView = z.infer<typeof Direction>;

export const DirectionsBody = z.object({
  // Null before a resume is imported.
  directions: z
    .object({
      hasReport: z.boolean(),
      list: z.array(Direction),
      gaps: z.array(Gap),
    })
    .nullable(),
});
export type DirectionsView = z.infer<typeof DirectionsBody>;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const jobs = (n: number) => count(n, "job", "jobs");

export type DirectionRow = {
  key: string;
  role: string;
  coverage: string;
  evidence: string;
  fresh: string;
  gaps: string[];
};

// One direction in words: how much of what its jobs ask for Paul's work covers, how many of his
// lines back it, how many of its jobs are fresh, and what its jobs ask for most that he can't
// prove yet.
export function directionRow(d: CareerDirectionView): DirectionRow {
  return {
    key: String(d.rank),
    role: d.role,
    coverage:
      d.coverage === null
        ? `${jobs(d.jobCount)}; they list no must-haves`
        : `Your work covers ${d.coverage}% of what ${jobs(d.jobCount)} ask for`,
    evidence: `Backed by ${count(d.matchedAtoms, "line", "lines")} of your work`,
    fresh:
      d.freshJobs === 0
        ? "None posted in the last 7 days"
        : `${count(d.freshJobs, "job", "jobs")} posted in the last 7 days`,
    gaps: d.gaps.map((g) => `${g.requirement} (${jobs(g.jobs)})`),
  };
}

// One "proof to build" suggestion and why it is there, keyed by its place in the list.
export function gapLine(g: ProofGap): { key: string; what: string; why: string } {
  if (g.kind === "dimension") {
    return {
      key: String(g.rank),
      what: `Build proof for ${g.label}`,
      why:
        g.band === "not_enough"
          ? `Not enough evidence yet: ${count(g.evidenceCount, "item", "items")}`
          : `Low evidence: ${count(g.evidenceCount, "item", "items")}`,
    };
  }
  return {
    key: String(g.rank),
    what: `Build proof for ${g.requirement}`,
    why: `${g.share}% of ${g.role} jobs ask for it (${jobs(g.jobs)})`,
  };
}

// What the sections say when there is nothing to list.
export const NO_RESUME_DIRECTIONS = "Import your resume to see which roles your work points to.";
export const NO_DIRECTIONS =
  "No directions yet: they need at least 2 ready jobs with the same kind of title.";
export const NO_GAPS = "Nothing to suggest: no thin evidence and no gap most jobs share.";
export const NO_REPORT_GAPS =
  "Suggestions from your dimensions appear once your Career DNA report is built.";
