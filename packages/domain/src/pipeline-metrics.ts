import type { ApplicationStatus } from "./application-status.js";
import { wilson } from "./stats.js";

// Pipeline metrics (NS-208, DSH-002, DSH-004): the funnel, time in stage and response rates by
// source, fit band and time to apply, from each application's status moves. Plain code, no I/O.
// A rate with fewer than MIN_SAMPLE data points is "not enough data", never a percentage (DX-003).

export const MIN_SAMPLE = 20;

export type FitBandKey = "queue" | "suggest" | "skip";

export type ApplicationHistory = {
  createdAt: Date;
  // The job's ATS, or null for none.
  source: string | null;
  fitBand: FitBandKey | null;
  // When the job was posted (or first seen), or null when unknown.
  postedAt: Date | null;
  // Status moves, oldest first.
  moves: { to: ApplicationStatus; at: Date }[];
};

export type Rate = {
  k: number;
  n: number;
  // False below MIN_SAMPLE: then rate, low and high are null.
  enough: boolean;
  rate: number | null;
  low: number | null;
  high: number | null;
};

export const FUNNEL_STAGES = [
  "discovered",
  "applied",
  "responded",
  "interviewing",
  "offer",
] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export type Median = { days: number | null; n: number };
export type Group = { key: string; rate: Rate };

export type PipelineMetrics = {
  funnel: { stage: FunnelStage; count: number; fromPrevious: Rate | null }[];
  timeInStage: { toApply: Median; toResponse: Median };
  responseBy: { source: Group[]; band: Group[]; timeToApply: Group[] };
};

const DAY_MS = 24 * 60 * 60 * 1000;
// A reply from the employer, good or bad. Ghosted and withdrawn are not replies.
const RESPONSES: ReadonlySet<ApplicationStatus> = new Set(["in_process", "offer", "rejected"]);
const INTERVIEWING: ReadonlySet<ApplicationStatus> = new Set(["in_process", "offer"]);

export function rate(k: number, n: number): Rate {
  if (n < MIN_SAMPLE) return { k, n, enough: false, rate: null, low: null, high: null };
  const [low, high] = wilson(k, n);
  return { k, n, enough: true, rate: k / n, low, high };
}

function median(values: number[]): Median {
  if (values.length === 0) return { days: null, n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const days =
    sorted.length % 2 === 1
      ? (sorted[mid] ?? 0)
      : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  // Tenths of a day are as precise as anyone reads a median.
  return { days: Math.round(days * 10) / 10, n: values.length };
}

// The first move to one of these statuses at or after `after`, if any.
function firstAt(
  h: ApplicationHistory,
  statuses: ReadonlySet<ApplicationStatus>,
  after?: Date,
): Date | null {
  const move = h.moves.find(
    (m) => statuses.has(m.to) && (after === undefined || m.at.getTime() >= after.getTime()),
  );
  return move?.at ?? null;
}

// Under 1 day, 1–3 days, over 3 days from posting to applying, or unknown.
export function timeToApplyBucket(postedAt: Date | null, appliedAt: Date): string {
  if (postedAt === null) return "unknown";
  const days = (appliedAt.getTime() - postedAt.getTime()) / DAY_MS;
  if (days < 1) return "under_1d";
  if (days <= 3) return "1_3d";
  return "over_3d";
}

const BUCKET_ORDER = ["under_1d", "1_3d", "over_3d", "unknown"];
const BAND_ORDER = ["queue", "suggest", "skip", "unscored"];

// Response rate per key, in the given order first and then alphabetically.
function groups(
  rows: { key: string; responded: boolean }[],
  order: readonly string[] = [],
): Group[] {
  const by = new Map<string, { k: number; n: number }>();
  for (const r of rows) {
    const g = by.get(r.key) ?? { k: 0, n: 0 };
    g.n++;
    if (r.responded) g.k++;
    by.set(r.key, g);
  }
  const rank = (key: string) => {
    const i = order.indexOf(key);
    return i === -1 ? order.length : i;
  };
  return [...by.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([key, g]) => ({ key, rate: rate(g.k, g.n) }));
}

export function pipelineMetrics(histories: readonly ApplicationHistory[]): PipelineMetrics {
  const applied: { h: ApplicationHistory; at: Date; respondedAt: Date | null }[] = [];
  let interviewing = 0;
  let offers = 0;
  for (const h of histories) {
    const at = firstAt(h, new Set(["submitted"]));
    if (at === null) continue;
    applied.push({ h, at, respondedAt: firstAt(h, RESPONSES, at) });
    if (firstAt(h, INTERVIEWING, at) !== null) interviewing++;
    if (firstAt(h, new Set(["offer"]), at) !== null) offers++;
  }
  const responded = applied.filter((a) => a.respondedAt !== null).length;
  const counts = [histories.length, applied.length, responded, interviewing, offers];
  const funnel = FUNNEL_STAGES.map((stage, i) => {
    const count = counts[i] ?? 0;
    const previous = i === 0 ? null : (counts[i - 1] ?? 0);
    return { stage, count, fromPrevious: previous === null ? null : rate(count, previous) };
  });
  return {
    funnel,
    timeInStage: {
      toApply: median(applied.map((a) => (a.at.getTime() - a.h.createdAt.getTime()) / DAY_MS)),
      toResponse: median(
        applied.flatMap((a) =>
          a.respondedAt === null ? [] : [(a.respondedAt.getTime() - a.at.getTime()) / DAY_MS],
        ),
      ),
    },
    responseBy: {
      source: groups(
        applied.map((a) => ({ key: a.h.source ?? "other", responded: a.respondedAt !== null })),
      ),
      band: groups(
        applied.map((a) => ({
          key: a.h.fitBand ?? "unscored",
          responded: a.respondedAt !== null,
        })),
        BAND_ORDER,
      ),
      timeToApply: groups(
        applied.map((a) => ({
          key: timeToApplyBucket(a.h.postedAt, a.at),
          responded: a.respondedAt !== null,
        })),
        BUCKET_ORDER,
      ),
    },
  };
}
