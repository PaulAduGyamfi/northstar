import { describe, expect, it } from "vitest";
import { gradeRecruiterExtract } from "./recruiter-extract.js";

// Synthetic email and facts only.
const input = { email: "Hi Paul, Dana at Initech here. We're hiring a Staff Engineer, remote." };
const facts = {
  roleTitle: "Staff Engineer",
  seniority: "Staff",
  company: "Initech",
  location: null,
  remote: "remote",
  salaryMin: null,
  salaryMax: null,
  salaryCurrency: null,
  salaryPeriod: null,
  agency: false,
  personalizedQuote: null,
  redFlags: [],
};

describe("gradeRecruiterExtract", () => {
  it("passes facts that the email states and the case expects", () => {
    const expected = { fields: { roleTitle: "Staff Engineer", company: "Initech" }, redFlags: [] };
    expect(gradeRecruiterExtract(facts, expected, input)).toBe(true);
  });

  it("fails a reading the check had to trim, such as an invented salary", () => {
    const expected = { fields: {}, redFlags: [] };
    expect(gradeRecruiterExtract({ ...facts, salaryMin: 500_000 }, expected, input)).toBe(false);
  });

  it("fails a reading whose field differs from the case", () => {
    const expected = { fields: { company: null }, redFlags: [] };
    expect(gradeRecruiterExtract(facts, expected, input)).toBe(false);
  });

  it("fails a reading that misses an expected red flag", () => {
    const expected = { fields: {}, redFlags: ["vague_role"] };
    expect(gradeRecruiterExtract(facts, expected, input)).toBe(false);
  });
});
