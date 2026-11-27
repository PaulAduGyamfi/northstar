import { describe, expect, it } from "vitest";
import {
  type CareerDirectionView,
  DirectionsBody,
  directionRow,
  gapLine,
} from "./career-directions";

// The words for directions and evidence gaps on the Career DNA page (NS-130 slice 9). Invented
// roles and requirements only.

const DIRECTION: CareerDirectionView = {
  rank: 1,
  role: "backend engineer",
  jobCount: 4,
  coverage: 62,
  matchedAtoms: 3,
  gaps: [
    { requirement: "Kafka", jobs: 3 },
    { requirement: "Rust", jobs: 1 },
  ],
  freshJobs: 2,
};

describe("directionRow", () => {
  it("says a direction's coverage, evidence, fresh jobs and gaps in words", () => {
    expect(directionRow(DIRECTION)).toEqual({
      key: "1",
      role: "backend engineer",
      coverage: "Your work covers 62% of what 4 jobs ask for",
      evidence: "Backed by 3 lines of your work",
      fresh: "2 jobs posted in the last 7 days",
      gaps: ["Kafka (3 jobs)", "Rust (1 job)"],
    });
  });

  it("uses singular counts and says when nothing is fresh or no must-haves are listed", () => {
    const row = directionRow({ ...DIRECTION, coverage: null, matchedAtoms: 1, freshJobs: 0 });
    expect([row.coverage, row.evidence, row.fresh]).toEqual([
      "4 jobs; they list no must-haves",
      "Backed by 1 line of your work",
      "None posted in the last 7 days",
    ]);
  });
});

describe("gapLine", () => {
  it("suggests proof for a thin or low dimension, with its evidence count", () => {
    expect([
      gapLine({
        rank: 1,
        kind: "dimension",
        label: "Leadership",
        band: "not_enough",
        evidenceCount: 1,
      }),
      gapLine({
        rank: 2,
        kind: "dimension",
        label: "Communication",
        band: "low",
        evidenceCount: 4,
      }),
    ]).toEqual([
      {
        key: "1",
        what: "Build proof for Leadership",
        why: "Not enough evidence yet: 1 item",
      },
      {
        key: "2",
        what: "Build proof for Communication",
        why: "Low evidence: 4 items",
      },
    ]);
  });

  it("suggests proof for a requirement, with the share of jobs that ask for it", () => {
    expect(
      gapLine({
        rank: 3,
        kind: "requirement",
        requirement: "Kafka",
        role: "backend engineer",
        jobs: 3,
        share: 75,
      }),
    ).toEqual({
      key: "3",
      what: "Build proof for Kafka",
      why: "75% of backend engineer jobs ask for it (3 jobs)",
    });
  });
});

describe("DirectionsBody", () => {
  it("accepts no directions before a resume import and refuses an unknown gap kind", () => {
    expect([
      DirectionsBody.safeParse({ directions: null }).success,
      DirectionsBody.safeParse({
        directions: { hasReport: true, list: [], gaps: [{ kind: "other" }] },
      }).success,
    ]).toEqual([true, false]);
  });
});
