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

  it("reads a track's goal, definition of done and milestones from the indented lines under it", () => {
    const file = [
      "cloud-cert | Cloud certification | cert | active | 4",
      "  goal: Pass the associate exam",
      "  done when: Certificate issued",
      "  - Sections 1-12 | done 2026-11-20",
      "  - Practice exams at 80%",
      "  - Exam booked",
      "side-app | Budget app | project | paused | 2",
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
          target: null,
          untouchedDays: 7,
          next: null,
          goal: "Pass the associate exam",
          doneWhen: "Certificate issued",
          milestones: [
            { title: "Sections 1-12", doneOn: "2026-11-20" },
            { title: "Practice exams at 80%", doneOn: null },
            { title: "Exam booked", doneOn: null },
          ],
        },
        {
          key: "side-app",
          name: "Budget app",
          type: "project",
          status: "paused",
          priority: 2,
          target: null,
          untouchedDays: 7,
          next: null,
        },
      ],
    });
  });

  it("names every bad indented line and stores nothing", () => {
    const file = [
      "  goal: Before any track",
      "ok | Fine | skill | active | 1",
      "  goal: One",
      "  goal: Two",
      "  done when: ",
      "  - Booked | done 2026-02-30",
      "  - Booked | soon",
      "  notes: anything",
      `  - ${"x".repeat(201)}`,
      `  goal: ${"y".repeat(301)}`,
    ].join("\n");
    expect(parseGrowthTracks(file)).toEqual({
      ok: false,
      error: [
        { line: 1, problem: "an indented line must come under a track" },
        { line: 4, problem: "goal is given twice for this track" },
        { line: 5, problem: "the done when must be 1 to 300 characters" },
        { line: 6, problem: "a milestone is: - <title> [| done YYYY-MM-DD]" },
        { line: 7, problem: "a milestone is: - <title> [| done YYYY-MM-DD]" },
        { line: 8, problem: 'an indented line is "goal: …", "done when: …" or "- <milestone>"' },
        { line: 9, problem: "a milestone must be 1 to 200 characters" },
        { line: 10, problem: "goal is given twice for this track" },
      ],
    });
  });

  it("allows at most 20 milestones a track", () => {
    const file = [
      "ok | Fine | skill | active | 1",
      ...Array.from({ length: 21 }, (_, i) => `  - Step ${i + 1}`),
    ].join("\n");
    expect(parseGrowthTracks(file)).toEqual({
      ok: false,
      error: [{ line: 22, problem: "at most 20 milestones a track" }],
    });
  });

  it("names only the bad track line, not the indented lines under it", () => {
    const file = ["Bad Key | X | cert | active | 3", "  goal: Anything", "  - Step"].join("\n");
    expect(parseGrowthTracks(file)).toEqual({
      ok: false,
      error: [{ line: 1, problem: "the key must be 1–40 lowercase letters, digits or dashes" }],
    });
  });
});
