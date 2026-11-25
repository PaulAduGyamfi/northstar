import { describe, expect, it } from "vitest";
import { gradeProfileExtract } from "./profile-extract.js";

const text = `Sam Sample
Data Engineer, Example Freight · 2019 – 2022
• Built nightly loads in Python.
PROJECTS
• Wrote a CSV linter, https://lint.example.com`;

const output = {
  roles: [
    {
      key: "r1",
      employer: "Example Freight",
      title: "Data Engineer",
      // The resume gives years only: kept as years, never guessed months, and not "current".
      startMonth: "2019",
      endMonth: "2022",
      current: false,
    },
  ],
  education: [],
  atoms: [
    {
      roleKey: "r1",
      what: "Built nightly loads",
      how: ["Python"],
      impact: null,
      scope: null,
      startMonth: null,
      endMonth: null,
      sourceQuote: "Built nightly loads in Python.",
      evidenceLink: null,
    },
    {
      roleKey: null,
      what: "Wrote a CSV linter",
      how: [],
      impact: null,
      scope: null,
      startMonth: null,
      endMonth: null,
      sourceQuote: "Wrote a CSV linter, https://lint.example.com",
      evidenceLink: "https://lint.example.com",
    },
  ],
  skills: [],
  certifications: [],
  links: [],
};
const expected = {
  roles: [{ employer: "Example Freight", title: "Data Engineer" }],
  atoms: { min: 2, max: 2 },
  noImpact: true,
  yearOnlyDates: true,
  unassignedAtoms: 1,
  absent: ["Rust"],
};

describe("gradeProfileExtract", () => {
  it("passes an extraction that matches the expected roles, counts and provenance", () => {
    expect(gradeProfileExtract(output, expected, { text })).toBe(true);
  });

  it("fails when a role differs", () => {
    expect(
      gradeProfileExtract(
        output,
        { ...expected, roles: [{ employer: "Example Freight", title: "Engineer" }] },
        { text },
      ),
    ).toBe(false);
  });

  it("fails when the atom count is out of range", () => {
    expect(gradeProfileExtract(output, { ...expected, atoms: { min: 3, max: 5 } }, { text })).toBe(
      false,
    );
  });

  it("fails when a resume with no results gets an impact", () => {
    const withImpact = structuredClone(output);
    const atom = withImpact.atoms[0];
    if (atom) (atom as { impact: string | null }).impact = "faster loads";
    expect(gradeProfileExtract(withImpact, expected, { text })).toBe(false);
  });

  it("fails when a year-only role date became a month, even one the resume states elsewhere", () => {
    // March 2019 is written right under the role (an award line), so provenance alone accepts
    // it; the case's yearOnlyDates rule is what catches it.
    const withAward = text.replace(
      "2019 – 2022\n",
      "2019 – 2022\nAward: Example Prize, March 2019\n",
    );
    expect(gradeProfileExtract(output, expected, { text: withAward })).toBe(true);
    const guessed = structuredClone(output);
    const role = guessed.roles[0];
    if (role) (role as { startMonth: string | null }).startMonth = "2019-03";
    expect(gradeProfileExtract(guessed, expected, { text: withAward })).toBe(false);
  });

  it("fails when a year-only role date was dropped, which provenance alone accepts", () => {
    const dropped = structuredClone(output);
    const role = dropped.roles[0];
    if (role) (role as { endMonth: string | null }).endMonth = null;
    expect(gradeProfileExtract(dropped, expected, { text })).toBe(false);
  });

  it("fails when text that must not appear does, even if it is really in the resume", () => {
    // "nightly" is in the resume and in a faithful atom, so provenance passes; absent catches it.
    expect(gradeProfileExtract(output, { ...expected, absent: ["nightly"] }, { text })).toBe(false);
  });

  it("fails when the provenance check fails", () => {
    const invented = structuredClone(output);
    const atom = invented.atoms[0];
    if (atom) atom.sourceQuote = "Built nightly loads in Scala.";
    expect(gradeProfileExtract(invented, expected, { text })).toBe(false);
  });
});
