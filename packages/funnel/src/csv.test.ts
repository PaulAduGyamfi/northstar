import { describe, expect, it } from "vitest";
import { parseCsv, parseTracker } from "./csv.js";

// Synthetic companies only (the repo is public).
const HEADER = "company,role,applied_on,stage_reached,outcome,outcome_on,channel,notes";

describe("parseCsv", () => {
  it("reads quoted fields with commas, doubled quotes and CRLF line ends", () => {
    expect(parseCsv('a,"b, c","say ""hi"""\r\n1,2,3\r\n')).toEqual([
      ["a", "b, c", 'say "hi"'],
      ["1", "2", "3"],
    ]);
  });

  it("keeps a newline inside quotes as part of the field", () => {
    expect(parseCsv('a,"line one\nline two"\n')).toEqual([["a", "line one\nline two"]]);
  });
});

describe("parseTracker", () => {
  it("reads valid rows with their file line numbers and drops notes", () => {
    const text = `${HEADER}\nGlobex,Backend Engineer,2026-03-02,screen,rejected,2026-03-20,referral,"call went ok, then no"\nInitech,Platform Engineer,2026-04-01,applied,open,,,\n`;
    expect(parseTracker(text)).toEqual({
      ok: true,
      value: [
        {
          line: 2,
          company: "Globex",
          role: "Backend Engineer",
          appliedOn: "2026-03-02",
          stageReached: "screen",
          outcome: "rejected",
          outcomeOn: "2026-03-20",
          channel: "referral",
        },
        {
          line: 3,
          company: "Initech",
          role: "Platform Engineer",
          appliedOn: "2026-04-01",
          stageReached: "applied",
          outcome: "open",
          outcomeOn: null,
          channel: null,
        },
      ],
    });
  });

  it("accepts the columns in any order and without the optional ones", () => {
    const text =
      "role,company,outcome,stage_reached,applied_on\nEngineer,Globex,open,applied,2026-03-02\n";
    const parsed = parseTracker(text);
    expect(parsed.ok && parsed.value[0]?.company).toBe("Globex");
  });

  it("refuses a missing or unknown column before reading any row", () => {
    expect(parseTracker("company,role,applied_on,stage,outcome\n")).toEqual({
      ok: false,
      error: [
        { line: 1, problem: "missing column stage_reached" },
        { line: 1, problem: "unknown column stage" },
      ],
    });
  });

  it("refuses bad rows by line number, naming the problem, never echoing the row", () => {
    const text = [
      HEADER,
      "Globex,Engineer,03/02/2026,screen,rejected,,cold,",
      "Initech,Engineer,2026-04-01,phone,open,,,",
      ",Engineer,2026-04-01,applied,open,,,",
      "Hooli,Engineer,2026-04-10,applied,rejected,2026-04-01,,",
      "Acme,Engineer,2026-04-10,screen,offer,,,",
      "Stark,Engineer,2026-02-30,applied,open,,friend,",
    ].join("\n");
    expect(parseTracker(text)).toEqual({
      ok: false,
      error: [
        { line: 2, problem: "applied_on must be a real date YYYY-MM-DD" },
        {
          line: 3,
          problem:
            "stage_reached must be one of applied, responded, screen, technical, onsite, offer",
        },
        { line: 4, problem: "company and role can't be empty" },
        { line: 5, problem: "outcome_on is before applied_on" },
        { line: 6, problem: "an offer outcome needs stage_reached offer" },
        { line: 7, problem: "applied_on must be a real date YYYY-MM-DD" },
      ],
    });
  });

  it("refuses a file with no rows", () => {
    expect(parseTracker(`${HEADER}\n`)).toEqual({
      ok: false,
      error: [{ line: 0, problem: "no rows in the file" }],
    });
  });
});
