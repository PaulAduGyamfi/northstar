import type { Channel } from "@northstar/db";
import { describe, expect, it } from "vitest";
import { judgeHypotheses, summarize } from "./hypotheses.js";
import type { FunnelRecord } from "./records.js";
import { type Baselines, buildReport } from "./report.js";

const NOW = new Date("2026-11-01T00:00:00Z");
const BASELINES: Baselines = {
  note: "test",
  steps: {
    "applied>responded": { rate: 0.1, source: "assumption" },
    "responded>screen": { rate: 0.6, source: "assumption" },
    "screen>technical": { rate: 0.5, source: "assumption" },
    "technical>onsite": { rate: 0.4, source: "assumption" },
    "onsite>offer": { rate: 0.3, source: "assumption" },
  },
};

// Synthetic records only. `hours` is the time to rejection.
function recs(n: number, over: Partial<FunnelRecord> & { hours?: number } = {}): FunnelRecord[] {
  const { hours = 72, ...rest } = over;
  return Array.from({ length: n }, (_, i) => {
    const appliedAt = new Date(Date.UTC(2026, 2, 1 + (i % 28)));
    return {
      company: `Company ${i}`,
      role: "Engineer",
      appliedAt,
      stage: "applied",
      outcome: "rejected",
      outcomeAt: new Date(appliedAt.getTime() + hours * 3_600_000),
      channel: null,
      source: "gmail",
      ...rest,
    };
  });
}
const board = (records: FunnelRecord[], facts: { mismatches: number } | null = null) =>
  judgeHypotheses(buildReport(records, BASELINES, NOW), records, facts);
const status = (records: FunnelRecord[], id: string, facts: { mismatches: number } | null = null) =>
  board(records, facts).find((h) => h.id === id)?.status;

describe("judgeHypotheses", () => {
  it("lists the ten hypotheses the diagnostics doc defines, in order", () => {
    expect(board([]).map((h) => h.id)).toEqual([
      "H1",
      "H2",
      "H3",
      "H4",
      "H5",
      "H6",
      "H8",
      "H9",
      "H10",
      "H11",
    ]);
  });

  it("H2 and H10: supported at exactly 30% fast rejections with 20 timed, weakened just below", () => {
    const at30 = [...recs(6, { hours: 5 }), ...recs(14, { hours: 72 })];
    const below = [...recs(5, { hours: 5 }), ...recs(15, { hours: 72 })];
    expect(status(at30, "H2")).toBe("supported");
    expect(status(at30, "H10")).toBe("supported");
    expect(status(below, "H2")).toBe("weakened");
  });

  it("H2: untested with 19 timed rejections, even if all were fast", () => {
    expect(status(recs(19, { hours: 1 }), "H2")).toBe("untested");
  });

  it("H6: supported at 85% cold with 20 known channels, weakened below, untested under 20", () => {
    const mix = (coldN: number, total: number): FunnelRecord[] =>
      recs(total).map((r, i) => ({ ...r, channel: (i < coldN ? "cold" : "referral") as Channel }));
    expect(status(mix(17, 20), "H6")).toBe("supported");
    expect(status(mix(16, 20), "H6")).toBe("weakened");
    expect(status(mix(19, 19), "H6")).toBe("untested");
  });

  it("H11: untested before any facts check, supported on a mismatch, weakened on none", () => {
    expect(status([], "H11", null)).toBe("untested");
    expect(status([], "H11", { mismatches: 2 })).toBe("supported");
    expect(status([], "H11", { mismatches: 0 })).toBe("weakened");
  });

  it("H4: supported when responded → screen is the leakiest step", () => {
    // 40 responded, 2 got a screen: 5% against an assumed 60%.
    const records = [...recs(38, { stage: "responded" }), ...recs(2, { stage: "screen" })];
    expect(status(records, "H4")).toBe("supported");
  });

  it("H4: weakened when responded → screen is at baseline, untested without the data", () => {
    const records = [...recs(10, { stage: "responded" }), ...recs(30, { stage: "screen" })];
    expect(status(records, "H4")).toBe("weakened");
    expect(status(recs(5, { stage: "responded" }), "H4")).toBe("untested");
  });

  it("H8: supported when a technical step leaks, weakened when both hold, untested without data", () => {
    const leak = [...recs(38, { stage: "screen" }), ...recs(2, { stage: "technical" })];
    expect(status(leak, "H8")).toBe("supported");
    const holds = [
      ...recs(10, { stage: "screen" }),
      ...recs(10, { stage: "technical" }),
      ...recs(20, { stage: "onsite" }),
    ];
    expect(status(holds, "H8")).toBe("weakened");
    expect(status([], "H8")).toBe("untested");
  });

  it("H1, H3, H5 and H9 stay untested and name the data they need", () => {
    const h = board(recs(50));
    for (const id of ["H1", "H3", "H5", "H9"])
      expect(h.find((x) => x.id === id)?.status).toBe("untested");
    expect(h.find((x) => x.id === "H1")?.evidence).toContain("NS-115");
  });
});

describe("summarize", () => {
  it("names the inconsistency first when the facts check found mismatches", () => {
    const records = [...recs(6, { hours: 5 }), ...recs(14, { hours: 72 })];
    const report = buildReport(records, BASELINES, NOW);
    const text = summarize(judgeHypotheses(report, records, { mismatches: 1 }), report);
    expect(text.startsWith("Most likely problem: Inconsistency (H11).")).toBe(true);
  });

  it("says there isn't enough data when nothing is supported and no step leaks", () => {
    const report = buildReport([], BASELINES, NOW);
    expect(summarize(judgeHypotheses(report, [], null), report)).toBe(
      "Not enough data yet to name a problem. Next: run `funnel backfill` and `funnel import` with your tracker.",
    );
  });
});
