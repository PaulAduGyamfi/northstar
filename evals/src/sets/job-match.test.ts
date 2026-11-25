import { describe, expect, it } from "vitest";
import { gradeJobMatch } from "./job-match.js";

// The job-match grader on synthetic data: what survives the provenance check must be exactly
// the expected matches.

const input = {
  requirements: ["5+ years leading engineering teams", "Experience with healthcare data"],
  atoms: [{ id: "atom-1", what: "Led a team of 6 engineers for 7 years", how: [] }],
};
const expected = { matched: [{ requirement: 0, atomId: "atom-1" }] };

describe("gradeJobMatch", () => {
  it("passes when exactly the expected requirements match", () => {
    const output = {
      matches: [
        { requirement: 0, atomId: "atom-1", quote: "for 7 years" },
        { requirement: 1, atomId: null, quote: null },
      ],
    };
    expect(gradeJobMatch(output, expected, input)).toBe(true);
  });

  it("fails an extra match that the provenance check keeps", () => {
    const output = {
      matches: [
        { requirement: 0, atomId: "atom-1", quote: "for 7 years" },
        { requirement: 1, atomId: "atom-1", quote: "Led a team" },
      ],
    };
    expect(gradeJobMatch(output, expected, input)).toBe(false);
  });

  it("fails an expected match whose quote isn't in the atom", () => {
    const output = { matches: [{ requirement: 0, atomId: "atom-1", quote: "for 9 years" }] };
    expect(gradeJobMatch(output, expected, input)).toBe(false);
  });

  it("fails output that doesn't fit the schema", () => {
    expect(gradeJobMatch({ matches: "all" }, expected, input)).toBe(false);
  });
});
