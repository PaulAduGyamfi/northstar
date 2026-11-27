import { CareerDnaSnapshot } from "@northstar/db";
import { describe, expect, it } from "vitest";
import { careerDnaSnapshot, changeLines, diffCareerDna } from "./history.js";
import { buildCareerDna } from "./report.js";

// Career DNA history (NS-130 slice 4, DNA-008): the stored snapshot and what changed. Synthetic
// atoms and stories only (public repo).

const atom = (id: string, line: string) => ({ id, what: line, how: [], sourceQuote: line });

const LEADERSHIP_THIN = {
  key: "leadership",
  band: "not_enough" as const,
  points: null,
  evidenceCount: 1,
  atomIds: ["a3"],
  storyIds: [],
};

const snapshot = (over: Partial<CareerDnaSnapshot> = {}): CareerDnaSnapshot => ({
  rubricVersion: 1,
  family: "software_engineering",
  dimensions: [
    {
      key: "engineering",
      band: "low",
      points: 4,
      evidenceCount: 3,
      atomIds: ["a1", "a2"],
      storyIds: ["s1"],
    },
    {
      key: "leadership",
      band: "not_enough",
      points: null,
      evidenceCount: 1,
      atomIds: ["a3"],
      storyIds: [],
    },
  ],
  archetype: { label: "The Builder", dimensions: ["engineering"] },
  ...over,
});

describe("careerDnaSnapshot", () => {
  it("keeps each dimension's band, points, count and cited ids, and no text", () => {
    const report = buildCareerDna({
      atoms: [
        atom("a1", "Built a payments ledger in Java."),
        atom("a2", "Implemented retry queues for card captures."),
        atom("a3", "Shipped a claims triage service."),
      ],
      stories: [],
    });
    const s = careerDnaSnapshot(report);
    expect(s.dimensions.find((d) => d.key === "engineering")).toEqual({
      key: "engineering",
      band: "low",
      points: 3,
      evidenceCount: 3,
      atomIds: ["a1", "a2", "a3"],
      storyIds: [],
    });
    expect(JSON.stringify(s)).not.toContain("payments ledger");
  });
});

describe("careerDnaSnapshot with stored ids", () => {
  it("gives a snapshot the save's own check accepts", () => {
    const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
    const report = buildCareerDna({
      atoms: [
        atom(id(1), "Built a payments ledger in Java."),
        atom(id(2), "Implemented retry queues for card captures."),
        atom(id(3), "Shipped a claims triage service."),
      ],
      stories: [{ id: id(4), competencies: ["ownership"] }],
    });
    expect(CareerDnaSnapshot.safeParse(careerDnaSnapshot(report)).success).toBe(true);
  });
});

describe("diffCareerDna", () => {
  it("says a first report is the first, counting its evidence", () => {
    const diff = diffCareerDna(null, snapshot());
    expect([diff.first, diff.gained, changeLines(diff)]).toEqual([
      true,
      4,
      ["This is your first Career DNA report."],
    ]);
  });

  it("reports a band crossing, points moving within a band, a new label and gained and lost evidence", () => {
    const next = snapshot({
      dimensions: [
        {
          key: "engineering",
          band: "low",
          points: 5,
          evidenceCount: 4,
          atomIds: ["a1", "a2", "a4"],
          storyIds: ["s1"],
        },
        {
          key: "leadership",
          band: "low",
          points: 3,
          evidenceCount: 3,
          atomIds: ["a5", "a6", "a7"],
          storyIds: [],
        },
      ],
      archetype: { label: "The Hands-On Organizer", dimensions: ["engineering", "leadership"] },
    });
    const diff = diffCareerDna(snapshot(), next);
    expect(diff.dimensions.map((d) => [d.key, d.direction, d.fromBand, d.toBand])).toEqual([
      ["engineering", "up", "low", "low"],
      ["leadership", "up", "not_enough", "low"],
    ]);
    expect([diff.gained, diff.lost]).toEqual([4, 1]);
    expect(changeLines(diff)).toEqual([
      "Your label is now The Hands-On Organizer.",
      "Engineering went up from 4 to 5 points.",
      "Leadership went up from not enough evidence to low.",
      "4 new pieces of evidence.",
      "1 piece of evidence no longer counted.",
    ]);
  });

  it("reports a dimension that went down, and a label that no longer fits", () => {
    const next = snapshot({
      dimensions: [
        {
          key: "engineering",
          band: "not_enough",
          points: null,
          evidenceCount: 2,
          atomIds: ["a1", "a2"],
          storyIds: [],
        },
        LEADERSHIP_THIN,
      ],
      archetype: null,
    });
    const diff = diffCareerDna(snapshot(), next);
    expect(changeLines(diff)).toEqual([
      "No label fits your evidence now.",
      "Engineering went down from low to not enough evidence.",
      "1 piece of evidence no longer counted.",
    ]);
  });

  it("says nothing changed for the same snapshot, and doesn't compare scores across rubrics", () => {
    expect(changeLines(diffCareerDna(snapshot(), snapshot()))).toEqual([
      "Nothing changed since your last report.",
    ]);
    const rubric2 = diffCareerDna(snapshot(), snapshot({ rubricVersion: 2 }));
    expect([rubric2.dimensions, changeLines(rubric2)]).toEqual([
      [],
      ["The scoring rubric changed, so scores aren't compared."],
    ]);
  });
});
