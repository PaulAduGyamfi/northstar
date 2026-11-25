import { readFileSync } from "node:fs";
import type { FunnelOutcome, FunnelStage } from "@northstar/db";
import { describe, expect, it } from "vitest";
import type { FunnelRecord } from "./records.js";
import { Baselines, buildReport, latencyBucket, renderReport, wilson } from "./report.js";

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

// n synthetic records at a stage and outcome, applied well before NOW.
function recs(
  n: number,
  stage: FunnelStage,
  outcome: FunnelOutcome = "rejected",
  hours = 72,
): FunnelRecord[] {
  return Array.from({ length: n }, (_, i) => {
    const appliedAt = new Date(Date.UTC(2026, 2, 1 + (i % 28)));
    return {
      company: `Company ${i}`,
      role: "Engineer",
      appliedAt,
      stage,
      outcome,
      outcomeAt: outcome === "rejected" ? new Date(appliedAt.getTime() + hours * 3_600_000) : null,
      channel: null,
      source: "gmail",
    };
  });
}

describe("wilson", () => {
  it("gives the 95% interval for 2 of 40", () => {
    const [low, high] = wilson(2, 40);
    expect(low).toBeCloseTo(0.0138, 3);
    expect(high).toBeCloseTo(0.1654, 3);
  });
});

describe("latencyBucket", () => {
  it("puts exactly 24 hours in 1–7 days and exactly 7 days still in 1–7 days", () => {
    expect(latencyBucket(23.99)).toBe("lt24h");
    expect(latencyBucket(24)).toBe("d1to7");
    expect(latencyBucket(168)).toBe("d1to7");
    expect(latencyBucket(168.01)).toBe("gt7d");
  });
});

describe("buildReport", () => {
  it("counts each stage cumulatively: a screen also counts as a response", () => {
    const r = buildReport([...recs(5, "applied"), ...recs(3, "screen")], BASELINES, NOW);
    expect(r.stageCounts).toEqual({
      applied: 8,
      responded: 3,
      screen: 3,
      technical: 0,
      onsite: 0,
      offer: 0,
    });
  });

  it("says insufficient data for a step with fewer than 20 data points", () => {
    const r = buildReport(recs(19, "applied"), BASELINES, NOW);
    expect(r.steps[0]).toMatchObject({ n: 19, status: "insufficient", rate: null });
    expect(r.leakiest).toBeNull();
  });

  it("names the leakiest step only when its whole interval is below baseline", () => {
    // 1 response in 60 (1.7%, interval 0.3%–8.9%) is wholly below the 10% assumption.
    const r = buildReport([...recs(59, "applied"), ...recs(1, "responded")], BASELINES, NOW);
    expect(r.steps[0]).toMatchObject({ n: 60, k: 1, status: "below" });
    expect(r.leakiest?.from).toBe("applied");
  });

  it("doesn't call a low rate a leak while its interval still reaches the baseline", () => {
    // 2 in 25 is 8%, but the interval reaches about 25%, so the 10% assumption is inside it.
    const r = buildReport([...recs(23, "applied"), ...recs(2, "responded")], BASELINES, NOW);
    expect(r.steps[0]?.status).toBe("ok");
    expect(r.leakiest).toBeNull();
  });

  it("leaves applications from the last 14 days that are still open out of the rates", () => {
    const fresh: FunnelRecord = {
      company: "Fresh Co",
      role: "Engineer",
      appliedAt: new Date("2026-10-25T00:00:00Z"),
      stage: "applied",
      outcome: "open",
      outcomeAt: null,
      channel: null,
      source: "gmail",
    };
    const r = buildReport([...recs(20, "applied"), fresh], BASELINES, NOW);
    expect(r.tooNew).toBe(1);
    expect(r.steps[0]?.n).toBe(20);
  });

  it("buckets rejection latency and counts ghosted applications as never", () => {
    const r = buildReport(
      [
        ...recs(3, "applied", "rejected", 5),
        ...recs(2, "applied", "rejected", 100),
        ...recs(1, "applied", "rejected", 400),
        ...recs(4, "applied", "ghosted"),
      ],
      BASELINES,
      NOW,
    );
    expect(r.latency).toEqual({ lt24h: 3, d1to7: 2, gt7d: 1, never: 4 });
    expect(r.fastShare).toBeCloseTo(0.5, 5);
  });

  it("breaks responses down by channel and by month", () => {
    const withChannel = recs(4, "responded").map((x, i) => ({
      ...x,
      channel: i < 2 ? ("referral" as const) : ("cold" as const),
      stage: i === 0 ? ("screen" as const) : ("applied" as const),
    }));
    const r = buildReport(withChannel, BASELINES, NOW);
    expect(r.byChannel).toEqual({ cold: { n: 2, responded: 0 }, referral: { n: 2, responded: 1 } });
    expect(r.byMonth).toEqual({ "2026-03": { n: 4, responded: 1 } });
  });
});

describe("renderReport", () => {
  it("prints every step with its sample size, marks baselines assumed, and says insufficient data", () => {
    const text = renderReport(buildReport(recs(10, "applied"), BASELINES, NOW)).join("\n");
    expect(text).toContain("applied → responded: insufficient data (n = 10, needs 20)");
    expect(text).toContain("(assumed baseline 10%)");
    expect(text).toContain("Leakiest stage: not enough data to say yet.");
  });
});

describe("funnel-baselines.json", () => {
  it("the committed file parses and labels every rate as an assumption", () => {
    const raw = JSON.parse(
      readFileSync(new URL("../funnel-baselines.json", import.meta.url), "utf8"),
    );
    const parsed = Baselines.parse(raw);
    expect(Object.values(parsed.steps).every((s) => s.source.startsWith("assumption"))).toBe(true);
  });
});
