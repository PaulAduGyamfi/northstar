import type { CareerDnaSnapshot } from "@northstar/db";
import { describe, expect, it } from "vitest";
import { careerDnaWording } from "./career-dna-wording.js";

// The real wording wired into GET /career-dna (NS-130 slice 8), on invented snapshots.

const ATOM = "00000000-0000-4000-8000-0000000000a1";

function snapshot(band: "medium" | "high", points: number): CareerDnaSnapshot {
  return {
    rubricVersion: 1,
    family: "software_engineering",
    dimensions: [
      { key: "engineering", band, points, evidenceCount: points, atomIds: [ATOM], storyIds: [] },
    ],
    archetype: null,
  };
}

const { describe: describeChange, labelOf } = careerDnaWording();

describe("careerDnaWording", () => {
  it("says a dimension went up from the older version to the newer one, in that order", () => {
    expect(describeChange(snapshot("medium", 7), snapshot("high", 11))).toEqual({
      first: false,
      changes: ["Engineering went up from medium to high."],
    });
  });

  it("gives the report's own first-report sentence when there is no older version", () => {
    expect(describeChange(null, snapshot("medium", 7))).toEqual({
      first: true,
      changes: ["This is your first Career DNA report."],
    });
  });

  it("names a rubric dimension and gives null for one the rubric doesn't have", () => {
    expect([labelOf("engineering"), labelOf("retired_dimension")]).toEqual(["Engineering", null]);
  });
});
