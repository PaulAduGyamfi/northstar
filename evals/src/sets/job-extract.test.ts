import { describe, expect, it } from "vitest";
import { gradeJobExtract } from "./job-extract.js";

// Synthetic page only (the repo is public).
const input = {
  url: "https://stark.example/jobs/backend",
  text: "Backend Engineer\nStark Systems\nSalary: $140,000 - $160,000\nRequirements\n- Go",
};
const expected = {
  isJobPosting: true,
  title: "Backend Engineer",
  company: "Stark Systems",
  salaryMin: 140000,
  salaryMax: 160000,
  requirements: 1,
  absent: ["Chief Technology Officer"],
};
const output = {
  isJobPosting: true,
  title: "Backend Engineer",
  company: "Stark Systems",
  location: null,
  remote: null,
  salaryMin: 140000,
  salaryMax: 160000,
  salaryCurrency: "USD",
  salaryPeriod: "year",
  seniority: null,
  requirements: ["Go"],
  niceToHaves: [],
  postedText: null,
};

describe("gradeJobExtract", () => {
  it("passes a correct extraction whose every value is in the page", () => {
    expect(gradeJobExtract(output, expected, input)).toBe(true);
  });

  it("fails when any value had to be dropped for not being in the page", () => {
    expect(gradeJobExtract({ ...output, seniority: "Senior" }, expected, input)).toBe(false);
  });

  it("fails a wrong salary, title or posting verdict", () => {
    expect(gradeJobExtract({ ...output, salaryMax: 140000 }, expected, input)).toBe(false);
    expect(
      gradeJobExtract(
        { ...output, title: "Engineer" },
        { ...expected, title: "Backend Engineer" },
        { ...input, text: `${input.text}\nEngineer` },
      ),
    ).toBe(false);
    expect(gradeJobExtract({ ...output, isJobPosting: false }, expected, input)).toBe(false);
  });

  it("fails output that contains an absent string", () => {
    const text = `${input.text}\nChief Technology Officer`;
    expect(
      gradeJobExtract(
        { ...output, title: "Chief Technology Officer" },
        { ...expected, title: undefined },
        { ...input, text },
      ),
    ).toBe(false);
  });
});
