import { z } from "zod";

// The pipeline metrics page (NS-208, DSH-002, DSH-004): the API's answer and the plain words it
// is shown in. Every rate shows its count, and one with too few data points says so (DX-003).

const Rate = z.object({
  k: z.number(),
  n: z.number(),
  enough: z.boolean(),
  rate: z.number().nullable(),
  low: z.number().nullable(),
  high: z.number().nullable(),
});
export type RateView = z.infer<typeof Rate>;
const Group = z.object({ key: z.string(), rate: Rate });
const Median = z.object({ days: z.number().nullable(), n: z.number() });

export const MetricsBody = z.object({
  funnel: z.array(
    z.object({
      stage: z.enum(["discovered", "applied", "responded", "interviewing", "offer"]),
      count: z.number(),
      fromPrevious: Rate.nullable(),
    }),
  ),
  timeInStage: z.object({ toApply: Median, toResponse: Median }),
  responseBy: z.object({
    source: z.array(Group),
    band: z.array(Group),
    timeToApply: z.array(Group),
  }),
});
export type MetricsView = z.infer<typeof MetricsBody>;

export const STAGE_WORDS: Record<MetricsView["funnel"][number]["stage"], string> = {
  discovered: "Found",
  applied: "Applied",
  responded: "Heard back",
  interviewing: "Interviewing",
  offer: "Offer",
};

// Group keys in words: bands, time-to-apply buckets and "other" for a job with no ATS.
const KEY_WORDS: Record<string, string> = {
  queue: "Queue band",
  suggest: "Suggest band",
  skip: "Skip band",
  unscored: "Not scored",
  under_1d: "Applied within a day of posting",
  "1_3d": "Applied 1–3 days after posting",
  over_3d: "Applied more than 3 days after posting",
  unknown: "Posting time unknown",
  other: "Other (no ATS)",
};

export const keyWords = (key: string): string => KEY_WORDS[key] ?? key;

const pct = (x: number): string => `${Math.round(x * 100)}%`;

// "40% (8 of 20; 22–61%)", or "not enough data yet (3 of 5)".
export function rateText(r: RateView): string {
  if (!r.enough || r.rate === null) return `not enough data yet (${r.k} of ${r.n})`;
  const range =
    r.low !== null && r.high !== null ? `; ${Math.round(r.low * 100)}–${pct(r.high)}` : "";
  return `${pct(r.rate)} (${r.k} of ${r.n}${range})`;
}

// "2.5 days (from 12)", or "no data yet".
export function medianText(m: { days: number | null; n: number }): string {
  if (m.days === null) return "no data yet";
  return `${m.days} ${m.days === 1 ? "day" : "days"} (from ${m.n})`;
}
