import type { Channel, FunnelStage } from "@northstar/db";
import { z } from "zod";
import { type FunnelRecord, STAGE_ORDER } from "./records.js";

// The funnel report (DX-003) and rejection latency (DX-005). Plain arithmetic: counts per stage,
// conversion with a 95% Wilson interval, and a leak named only when the evidence holds up.

// Below this many data points a step says "insufficient data" instead of a rate (DX-003).
export const MIN_SAMPLE = 20;
// Open applications this recent haven't had time to convert; they're left out of the rates.
export const TOO_NEW_DAYS = 14;
const DAY_MS = 86_400_000;

const STEP_KEYS = [
  "applied>responded",
  "responded>screen",
  "screen>technical",
  "technical>onsite",
  "onsite>offer",
] as const;

// funnel-baselines.json: an assumed rate per step, each with where it came from.
export const Baselines = z
  .object({
    note: z.string(),
    steps: z.object(
      Object.fromEntries(
        STEP_KEYS.map((k) => [
          k,
          z.object({ rate: z.number().gt(0).lt(1), source: z.string().min(1) }),
        ]),
      ) as Record<
        (typeof STEP_KEYS)[number],
        z.ZodObject<{ rate: z.ZodNumber; source: z.ZodString }>
      >,
    ),
  })
  .strict();
export type Baselines = z.infer<typeof Baselines>;

// The 95% Wilson score interval for k successes in n trials: honest at small n and near 0 or 1,
// where the plain p ± 1.96·se interval goes below zero.
export function wilson(k: number, n: number): [number, number] {
  const z2 = 1.96 ** 2;
  const p = k / n;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (1.96 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

export type LatencyBucket = "lt24h" | "d1to7" | "gt7d";

// Under 24 hours usually means an automated filter, not a person (13-search-diagnostics). Exactly
// 24 h and exactly 7 days both count as 1–7 days.
export function latencyBucket(hours: number): LatencyBucket {
  if (hours < 24) return "lt24h";
  if (hours <= 168) return "d1to7";
  return "gt7d";
}

export type Step = {
  from: FunnelStage;
  to: FunnelStage;
  n: number;
  k: number;
  // null when n is below MIN_SAMPLE.
  rate: number | null;
  low: number | null;
  high: number | null;
  baseline: number;
  status: "insufficient" | "below" | "ok";
};

export type Report = {
  total: number;
  tooNew: number;
  stageCounts: Record<FunnelStage, number>;
  steps: Step[];
  leakiest: Step | null;
  latency: Record<LatencyBucket, number> & { never: number };
  // Share of timed rejections that came in under 24 h; null with none.
  fastShare: number | null;
  byChannel: Partial<Record<Channel, { n: number; responded: number }>>;
  byMonth: Record<string, { n: number; responded: number }>;
};

const atLeast = (r: FunnelRecord, s: FunnelStage) =>
  STAGE_ORDER.indexOf(r.stage) >= STAGE_ORDER.indexOf(s);

export function buildReport(
  records: readonly FunnelRecord[],
  baselines: Baselines,
  now: Date,
): Report {
  const tooNew = (r: FunnelRecord) =>
    r.outcome === "open" && now.getTime() - r.appliedAt.getTime() < TOO_NEW_DAYS * DAY_MS;
  const included = records.filter((r) => !tooNew(r));

  const stageCounts = Object.fromEntries(
    STAGE_ORDER.map((s) => [s, included.filter((r) => atLeast(r, s)).length]),
  ) as Record<FunnelStage, number>;

  const steps: Step[] = STEP_KEYS.map((key, i) => {
    const from = STAGE_ORDER[i] as FunnelStage;
    const to = STAGE_ORDER[i + 1] as FunnelStage;
    const n = stageCounts[from];
    const k = stageCounts[to];
    const baseline = baselines.steps[key].rate;
    if (n < MIN_SAMPLE) {
      return {
        from,
        to,
        n,
        k,
        rate: null,
        low: null,
        high: null,
        baseline,
        status: "insufficient",
      };
    }
    const [low, high] = wilson(k, n);
    // A leak only when even the top of the interval is under the baseline: not just bad luck.
    const status = high < baseline ? "below" : "ok";
    return { from, to, n, k, rate: k / n, low, high, baseline, status };
  });
  // The step furthest below its baseline, relative to that baseline.
  const shortfall = (s: Step) => (s.baseline - (s.rate ?? 0)) / s.baseline;
  const leakiest =
    steps.filter((s) => s.status === "below").sort((a, b) => shortfall(b) - shortfall(a))[0] ??
    null;

  const latency = { lt24h: 0, d1to7: 0, gt7d: 0, never: 0 };
  for (const r of included) {
    if (r.outcome === "ghosted") latency.never += 1;
    if (r.outcome === "rejected" && r.outcomeAt) {
      latency[latencyBucket((r.outcomeAt.getTime() - r.appliedAt.getTime()) / 3_600_000)] += 1;
    }
  }
  const timed = latency.lt24h + latency.d1to7 + latency.gt7d;

  const byChannel: Report["byChannel"] = {};
  const byMonth: Report["byMonth"] = {};
  for (const r of included) {
    const responded = atLeast(r, "responded") ? 1 : 0;
    if (r.channel) {
      const c = byChannel[r.channel] ?? { n: 0, responded: 0 };
      byChannel[r.channel] = { n: c.n + 1, responded: c.responded + responded };
    }
    const month = r.appliedAt.toISOString().slice(0, 7);
    const m = byMonth[month] ?? { n: 0, responded: 0 };
    byMonth[month] = { n: m.n + 1, responded: m.responded + responded };
  }

  return {
    total: records.length,
    tooNew: records.length - included.length,
    stageCounts,
    steps,
    leakiest,
    latency,
    fastShare: timed === 0 ? null : latency.lt24h / timed,
    byChannel,
    byMonth,
  };
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

// The report as terminal lines (DX-003): every number with its sample size, baselines marked
// "assumed", and no verdict where the data is thin.
export function renderReport(r: Report): string[] {
  const lines = [
    `Funnel: ${r.total} applications${r.tooNew > 0 ? ` (${r.tooNew} from the last ${TOO_NEW_DAYS} days left out of the rates)` : ""}`,
    `  applied ${r.stageCounts.applied} → responded ${r.stageCounts.responded} → screen ${r.stageCounts.screen} → technical ${r.stageCounts.technical} → onsite ${r.stageCounts.onsite} → offer ${r.stageCounts.offer}`,
    "Conversion (95% interval):",
  ];
  for (const s of r.steps) {
    lines.push(
      s.rate === null
        ? `  ${s.from} → ${s.to}: insufficient data (n = ${s.n}, needs ${MIN_SAMPLE}) (assumed baseline ${pct(s.baseline)})`
        : `  ${s.from} → ${s.to}: ${pct(s.rate)} [${pct(s.low ?? 0)}–${pct(s.high ?? 0)}], ${s.k} of ${s.n} (assumed baseline ${pct(s.baseline)})${s.status === "below" ? "  ← below" : ""}`,
    );
  }
  lines.push(
    r.leakiest
      ? `Leakiest stage: ${r.leakiest.from} → ${r.leakiest.to}.`
      : "Leakiest stage: not enough data to say yet.",
  );
  const l = r.latency;
  lines.push(
    `Rejection latency: < 24 h ${l.lt24h} · 1–7 d ${l.d1to7} · > 7 d ${l.gt7d} · never answered ${l.never}`,
  );
  if (r.fastShare !== null && r.fastShare >= 0.3) {
    lines.push(
      `  ${pct(r.fastShare)} of timed rejections came within 24 h: likely knockout questions or ATS filters, not a person reading.`,
    );
  }
  lines.push(
    "  (Which form answers those rejections shared can't be checked yet: there are no form answers until the Apply Gateway, NS-120.)",
  );
  const channels = Object.entries(r.byChannel);
  if (channels.length > 0) {
    lines.push("By channel (responded / applications):");
    for (const [c, v] of channels) lines.push(`  ${c}: ${v.responded} / ${v.n}`);
  }
  lines.push("By month (responded / applications):");
  for (const [m, v] of Object.entries(r.byMonth).sort())
    lines.push(`  ${m}: ${v.responded} / ${v.n}`);
  return lines;
}
