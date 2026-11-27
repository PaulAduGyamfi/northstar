import { describe, expect, it } from "vitest";
import { ADJUSTABLE_REASONS, learnRecruiterWeights, MAX_ADJUSTMENT } from "./recruiter-learn.js";

// The recruiter-grading learning rule (NS-238 item 3 slice 2). Codes and letters only.

const sample = (reasons: string[], systemGrade: string, paulGrade: string) => ({
  reasons,
  systemGrade,
  paulGrade,
});

describe("learnRecruiterWeights", () => {
  it("averages Paul's letter minus the grader's per reason, once three regrades share it", () => {
    expect(
      learnRecruiterWeights([
        sample(["sender:agency", "title:exact"], "B", "D"),
        sample(["sender:agency"], "C", "D"),
        sample(["sender:agency", "title:exact"], "B", "C"),
      ]),
    ).toEqual({ "sender:agency": -1 });
  });

  it("holds an adjustment to two points either way", () => {
    const many = Array.from({ length: 4 }, () => sample(["personal:yes"], "F", "A"));
    expect([learnRecruiterWeights(many), MAX_ADJUSTMENT]).toEqual([{ "personal:yes": 2 }, 2]);
  });

  it("gives nothing under three regrades, or when the mean rounds to zero", () => {
    expect([
      learnRecruiterWeights([sample(["pay:ok"], "B", "A"), sample(["pay:ok"], "B", "A")]),
      learnRecruiterWeights([
        sample(["pay:ok"], "B", "A"),
        sample(["pay:ok"], "B", "C"),
        sample(["pay:ok"], "B", "B"),
      ]),
    ]).toEqual([{}, {}]);
  });

  it("rounds a negative half away from zero, as a positive one", () => {
    expect([
      learnRecruiterWeights([
        sample(["place:ok"], "B", "C"),
        sample(["place:ok"], "B", "B"),
        sample(["place:ok"], "B", "C"),
        sample(["place:ok"], "B", "B"),
      ]),
      learnRecruiterWeights([
        sample(["place:ok"], "B", "A"),
        sample(["place:ok"], "B", "B"),
        sample(["place:ok"], "B", "A"),
        sample(["place:ok"], "B", "B"),
      ]),
    ]).toEqual([{ "place:ok": -1 }, { "place:ok": 1 }]);
  });

  it("never adjusts a dealbreaker or a red flag, and ignores unknown codes and letters", () => {
    const capped = Array.from({ length: 3 }, () =>
      sample(["dealbreaker", "red_flag:vague_role", "made:up"], "F", "A"),
    );
    expect([
      learnRecruiterWeights([...capped, sample(["pay:ok"], "Z", "A")]),
      ADJUSTABLE_REASONS.some((r) => r === "dealbreaker" || r.startsWith("red_flag:")),
    ]).toEqual([{}, false]);
  });
});
