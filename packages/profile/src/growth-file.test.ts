import { describe, expect, it } from "vitest";
import { parseGrowthTracks } from "./growth-file.js";

// Paul's growth tracks file (NS-210). Invented tracks only.

describe("parseGrowthTracks", () => {
  it("reads each track with its options, skipping blanks and comments", () => {
    const file = [
      "# my tracks",
      "cloud-cert | Cloud certification | cert | active | 4 | target 2027-02-01 | next 60 Practice exam 1",
      "",
      "side-app | Budget app | project | paused | 2 | untouched 14",
    ].join("\n");
    expect(parseGrowthTracks(file)).toEqual({
      ok: true,
      value: [
        {
          key: "cloud-cert",
          name: "Cloud certification",
          type: "cert",
          status: "active",
          priority: 4,
          target: "2027-02-01",
          untouchedDays: 7,
          next: { minutes: 60, title: "Practice exam 1" },
        },
        {
          key: "side-app",
          name: "Budget app",
          type: "project",
          status: "paused",
          priority: 2,
          target: null,
          untouchedDays: 14,
          next: null,
        },
      ],
    });
  });

  it("refuses every bad line, naming it, and returns no tracks", () => {
    const file = [
      "Bad Key | X | cert | active | 3",
      "ok-1 | X | hobby | active | 3",
      "ok-2 | X | cert | active | 9",
      "ok-3 | X | cert | active | 3 | target 2027-02-30",
      "ok-4 | X | cert | active | 3 | soon",
      "ok-5 | X | cert",
      "ok-6 | Fine | skill | active | 1",
      "ok-6 | Again | skill | active | 1",
    ].join("\n");
    const result = parseGrowthTracks(file);
    expect(result.ok ? [] : result.error.map((p) => p.line)).toEqual([1, 2, 3, 4, 5, 6, 8]);
  });

  it("names the field the planner refuses, never its value", () => {
    const result = parseGrowthTracks("ok | Name | project | active | 3 | untouched 0");
    expect(result).toEqual({ ok: false, error: [{ line: 1, problem: "check untouchedDays" }] });
  });

  it("says when an option is given twice", () => {
    expect(
      parseGrowthTracks("ok | Name | cert | active | 3 | target 2027-01-01 | target 2027-02-01"),
    ).toEqual({
      ok: false,
      error: [{ line: 1, problem: "target is given twice" }],
    });
  });

  it("refuses a file with no tracks", () => {
    expect(parseGrowthTracks("# nothing\n")).toEqual({
      ok: false,
      error: [{ line: 1, problem: "the file has no tracks" }],
    });
  });
});
