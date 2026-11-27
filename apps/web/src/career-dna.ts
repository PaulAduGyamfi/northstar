import { z } from "zod";

// The Career DNA page (NS-130 slice 8, DNA-001/008): the API's answer and the plain words it is
// shown in. The report holds scores and counts only, never Paul's lines, so the page shows how much
// evidence each dimension has and what changed since the last version.

const Dimension = z.object({
  key: z.string(),
  // The rubric's name for the dimension; null when the current rubric no longer has it.
  label: z.string().nullable(),
  band: z.enum(["not_enough", "low", "medium", "high"]),
  // Null while the dimension has too little evidence for a score.
  points: z.number().nullable(),
  evidenceCount: z.number(),
});
export type CareerDnaDimension = z.infer<typeof Dimension>;

export const CareerDnaBody = z.object({
  report: z
    .object({
      version: z.number(),
      createdAt: z.string(),
      label: z.string().nullable(),
      dimensions: z.array(Dimension),
      // True for the first version: there is nothing to compare it with.
      first: z.boolean(),
      // Fixed sentences from the report's own diff (changeLines); empty when nothing changed.
      changes: z.array(z.string()),
    })
    .nullable(),
});
export type CareerDnaView = z.infer<typeof CareerDnaBody>;

const BAND_WORDS: Record<CareerDnaDimension["band"], string> = {
  not_enough: "Not enough evidence yet",
  low: "Low",
  medium: "Medium",
  high: "High",
};

const items = (n: number) => (n === 1 ? "1 item" : `${n} items`);

export type DimensionRow = { key: string; name: string; band: string; evidence: string };

// One dimension in words: its name, its band and how many items back it. Points stay off the
// page: the band is the reading, and the count says how much evidence it rests on.
export function dimensionRow(d: CareerDnaDimension): DimensionRow {
  return {
    key: d.key,
    name: d.label ?? d.key,
    band: BAND_WORDS[d.band],
    evidence: items(d.evidenceCount),
  };
}

// The "what changed" lines: the report's own sentences (changeLines in packages/profile), which
// already say when it is the first report or nothing changed. Only an empty list, which the API
// never sends, gets a line here, so the page never shows a blank section.
export function changeSummary(report: NonNullable<CareerDnaView["report"]>): string[] {
  if (report.changes.length > 0) return report.changes;
  return [
    report.first
      ? "This is your first Career DNA report."
      : "Nothing changed since your last report.",
  ];
}

// The header line: the version and the day it was built (the ISO date only, never a time zone
// guess).
export function versionLine(report: NonNullable<CareerDnaView["report"]>): string {
  return `Version ${report.version}, built ${report.createdAt.slice(0, 10)}`;
}

// What the page says before any report is stored.
export const NO_REPORT =
  "No Career DNA report yet. Import your resume, then run pnpm --filter @northstar/profile profile dna.";
