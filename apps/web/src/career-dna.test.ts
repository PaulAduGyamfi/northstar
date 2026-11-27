import { describe, expect, it } from "vitest";
import {
  CareerDnaBody,
  type CareerDnaView,
  changeSummary,
  dimensionRow,
  versionLine,
} from "./career-dna";

// The Career DNA page's words (NS-130 slice 8). Invented reports only.

type Report = NonNullable<CareerDnaView["report"]>;

const REPORT: Report = {
  version: 3,
  createdAt: "2026-11-27T04:30:00.000Z",
  label: "Builder",
  dimensions: [
    { key: "engineering", label: "Engineering", band: "high", points: 12, evidenceCount: 11 },
    { key: "leadership", label: "Leadership", band: "not_enough", points: null, evidenceCount: 1 },
  ],
  first: false,
  changes: ["Engineering moved up from Medium to High."],
};

describe("dimensionRow", () => {
  it("puts a scored dimension's band and evidence in words", () => {
    expect(dimensionRow(REPORT.dimensions[0] as Report["dimensions"][number])).toEqual({
      key: "engineering",
      name: "Engineering",
      band: "High",
      evidence: "11 items",
    });
  });

  it("says a thin dimension has not enough evidence, with a singular count", () => {
    expect(dimensionRow(REPORT.dimensions[1] as Report["dimensions"][number])).toEqual({
      key: "leadership",
      name: "Leadership",
      band: "Not enough evidence yet",
      evidence: "1 item",
    });
  });

  it("shows a dimension the current rubric doesn't know by its key, never dropping it", () => {
    expect(
      dimensionRow({ key: "design", label: null, band: "low", points: 3, evidenceCount: 3 }).name,
    ).toBe("design");
  });
});

describe("changeSummary", () => {
  it("passes the report's own change sentences through", () => {
    expect(changeSummary(REPORT)).toEqual(["Engineering moved up from Medium to High."]);
  });

  it("says when this is the first report", () => {
    expect(changeSummary({ ...REPORT, first: true, changes: [] })).toEqual([
      "This is your first report.",
    ]);
  });

  it("says when nothing changed since the last version", () => {
    expect(changeSummary({ ...REPORT, changes: [] })).toEqual([
      "Nothing changed since the last version.",
    ]);
  });
});

describe("versionLine", () => {
  it("gives the version and the build date only", () => {
    expect(versionLine(REPORT)).toBe("Version 3, built 2026-11-27");
  });
});

describe("CareerDnaBody", () => {
  it("accepts no report yet", () => {
    expect(CareerDnaBody.parse({ report: null })).toEqual({ report: null });
  });

  it("refuses a band outside the four the report uses", () => {
    const bad = { report: { ...REPORT, dimensions: [{ ...REPORT.dimensions[0], band: "huge" }] } };
    expect(CareerDnaBody.safeParse(bad).success).toBe(false);
  });
});
