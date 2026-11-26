import { describe, expect, it } from "vitest";
import type { ApplicationStatus } from "./application-status.js";
import {
  type ApplicationHistory,
  MIN_SAMPLE,
  pipelineMetrics,
  rate,
  timeToApplyBucket,
} from "./pipeline-metrics.js";

// Pipeline metrics (NS-208) from synthetic status histories.

const T0 = Date.parse("2026-11-01T00:00:00Z");
const day = (n: number) => new Date(T0 + n * 24 * 60 * 60 * 1000);

function history(
  path: [ApplicationStatus, number][],
  over: Partial<ApplicationHistory> = {},
): ApplicationHistory {
  return {
    createdAt: day(0),
    source: "greenhouse",
    fitBand: "queue",
    postedAt: day(0),
    moves: path.map(([to, d]) => ({ to, at: day(d) })),
    ...over,
  };
}

const applied = (submitDay: number) => history([["submitted", submitDay]]);
const repliedIn = (submitDay: number, replyDay: number, to: ApplicationStatus = "rejected") =>
  history([
    ["submitted", submitDay],
    [to, replyDay],
  ]);

describe("rate", () => {
  it(`says not enough data below ${MIN_SAMPLE}, and gives the rate with its interval from there`, () => {
    const small = rate(5, MIN_SAMPLE - 1);
    const big = rate(10, 40);
    expect([small, big.rate, (big.low ?? 1) < 0.25, (big.high ?? 0) > 0.25]).toEqual([
      { k: 5, n: 19, enough: false, rate: null, low: null, high: null },
      0.25,
      true,
      true,
    ]);
  });
});

describe("pipelineMetrics", () => {
  it("counts each funnel stage from the status moves", () => {
    const hs = [
      history([["queued", 0]]),
      applied(1),
      repliedIn(1, 5, "rejected"),
      repliedIn(1, 3, "in_process"),
      history([
        ["submitted", 2],
        ["in_process", 4],
        ["offer", 9],
      ]),
      history([
        ["submitted", 2],
        ["ghosted", 30],
      ]),
    ];
    const m = pipelineMetrics(hs);
    expect(m.funnel.map((f) => [f.stage, f.count, f.fromPrevious?.k, f.fromPrevious?.n])).toEqual([
      ["discovered", 6, undefined, undefined],
      ["applied", 5, 5, 6],
      ["responded", 3, 3, 5],
      ["interviewing", 2, 2, 3],
      ["offer", 1, 1, 2],
    ]);
  });

  it("gives the median days to apply and to the first reply", () => {
    const m = pipelineMetrics([repliedIn(1, 5), repliedIn(3, 4), applied(2)]);
    expect(m.timeInStage).toEqual({
      toApply: { days: 2, n: 3 },
      toResponse: { days: 2.5, n: 2 },
    });
  });

  it("ignores a reply recorded before the application went out", () => {
    const odd = history([
      ["rejected", 1],
      ["submitted", 2],
    ]);
    expect(pipelineMetrics([odd]).funnel[2]?.count).toBe(0);
  });

  it("breaks the response rate down by source, band and time to apply, with sample sizes", () => {
    const many = (n: number, make: () => ApplicationHistory) => Array.from({ length: n }, make);
    const hs = [
      ...many(15, () => repliedIn(0.5, 3)),
      ...many(5, () => applied(0.5)),
      ...many(3, () => history([["submitted", 5]], { source: null, fitBand: null })),
    ];
    const m = pipelineMetrics(hs);
    expect([
      m.responseBy.source.map((g) => [g.key, g.rate.k, g.rate.n, g.rate.rate]),
      m.responseBy.band.map((g) => [g.key, g.rate.n, g.rate.enough]),
      m.responseBy.timeToApply.map((g) => [g.key, g.rate.n]),
    ]).toEqual([
      [
        ["greenhouse", 15, 20, 0.75],
        ["other", 0, 3, null],
      ],
      [
        ["queue", 20, true],
        ["unscored", 3, false],
      ],
      [
        ["under_1d", 20],
        ["over_3d", 3],
      ],
    ]);
  });

  it("is empty but well-formed with no applications", () => {
    const m = pipelineMetrics([]);
    expect([m.funnel.map((f) => f.count), m.timeInStage.toApply, m.responseBy.source]).toEqual([
      [0, 0, 0, 0, 0],
      { days: null, n: 0 },
      [],
    ]);
  });
});

describe("timeToApplyBucket", () => {
  it("buckets by days from posting, and says unknown without a posting time", () => {
    expect([
      timeToApplyBucket(day(0), day(0.9)),
      timeToApplyBucket(day(0), day(3)),
      timeToApplyBucket(day(0), day(3.1)),
      timeToApplyBucket(null, day(1)),
    ]).toEqual(["under_1d", "1_3d", "over_3d", "unknown"]);
  });
});
