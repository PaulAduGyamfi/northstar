import { describe, expect, it } from "vitest";
import { evidenceGaps, type GapDirection } from "./gaps.js";
import type { DimensionScore } from "./score.js";

// Synthetic scores, directions and tracks (public repo).
function dim(
  key: string,
  label: string,
  band: DimensionScore["band"],
  count: number,
): DimensionScore {
  return {
    key,
    label,
    band,
    points: band === "not_enough" ? null : count,
    evidenceCount: count,
    cites: [],
  };
}

const dims = [
  dim("engineering", "Engineering", "high", 12),
  dim("architecture", "Architecture", "low", 4),
  dim("infrastructure", "Infrastructure", "not_enough", 1),
  dim("leadership", "Leadership", "medium", 7),
];

const backend: GapDirection = {
  role: "backend engineer",
  jobCount: 8,
  gaps: [
    { requirement: "Kafka", jobs: 4 },
    { requirement: "AWS", jobs: 3 },
    { requirement: "Rust", jobs: 1 },
    { requirement: "gRPC", jobs: 2 },
  ],
};

describe("evidenceGaps", () => {
  it("suggests proof for each low or thin dimension, in rubric order, and none for medium or high", () => {
    const gaps = evidenceGaps(dims, [], []);
    expect(gaps).toEqual([
      {
        kind: "dimension",
        dimension: "architecture",
        label: "Architecture",
        band: "low",
        evidenceCount: 4,
        suggestion: "Build proof for Architecture",
      },
      {
        kind: "dimension",
        dimension: "infrastructure",
        label: "Infrastructure",
        band: "not_enough",
        evidenceCount: 1,
        suggestion: "Build proof for Infrastructure",
      },
    ]);
  });

  it("suggests a requirement two or more jobs and a quarter or more of a direction ask for, largest share first", () => {
    const gaps = evidenceGaps([], [backend], []);
    expect(gaps).toEqual([
      {
        kind: "requirement",
        requirement: "Kafka",
        role: "backend engineer",
        jobs: 4,
        share: 50,
        suggestion: "Build proof for Kafka",
      },
      {
        kind: "requirement",
        requirement: "AWS",
        role: "backend engineer",
        jobs: 3,
        share: 38,
        suggestion: "Build proof for AWS",
      },
      {
        kind: "requirement",
        requirement: "gRPC",
        role: "backend engineer",
        jobs: 2,
        share: 25,
        suggestion: "Build proof for gRPC",
      },
    ]);
  });

  it("leaves out a requirement under a quarter of the direction's jobs even when two ask for it", () => {
    const big: GapDirection = {
      role: "data engineer",
      jobCount: 10,
      gaps: [{ requirement: "Spark", jobs: 2 }],
    };
    expect(evidenceGaps([], [big], [])).toEqual([]);
  });

  it("lists a requirement two directions share once, from the direction where its share is largest", () => {
    const data: GapDirection = {
      role: "data engineer",
      jobCount: 4,
      gaps: [{ requirement: "kafka", jobs: 3 }],
    };
    const gaps = evidenceGaps([], [backend, data], []);
    const kafka = gaps.filter(
      (g) => g.kind === "requirement" && g.requirement.toLowerCase() === "kafka",
    );
    expect(kafka).toEqual([
      {
        kind: "requirement",
        requirement: "kafka",
        role: "data engineer",
        jobs: 3,
        share: 75,
        suggestion: "Build proof for kafka",
      },
    ]);
  });

  it("skips a gap an active or planned track already names, either way round", () => {
    const tracks = [
      { name: "AWS Solutions Architect", status: "active" as const },
      { name: "Kafka", status: "backlogged" as const },
      { name: "Infrastructure as code", status: "active" as const },
    ];
    const gaps = evidenceGaps(dims, [backend], tracks);
    expect(gaps.map((g) => (g.kind === "dimension" ? g.label : g.requirement))).toEqual([
      "Architecture",
      "gRPC",
    ]);
  });

  it("still suggests a gap whose only track is done or paused", () => {
    const tracks = [
      { name: "Kafka", status: "done" as const },
      { name: "AWS", status: "paused" as const },
    ];
    const gaps = evidenceGaps([], [backend], tracks);
    expect(gaps.map((g) => (g.kind === "requirement" ? g.requirement : ""))).toEqual([
      "Kafka",
      "AWS",
      "gRPC",
    ]);
  });

  it("matches track names as whole words, so a track named Go doesn't cover Google Cloud", () => {
    const dir: GapDirection = {
      role: "x",
      jobCount: 2,
      gaps: [{ requirement: "Google Cloud", jobs: 2 }],
    };
    const gaps = evidenceGaps([], [dir], [{ name: "Go", status: "active" }]);
    expect(gaps).toHaveLength(1);
  });
});
