import type { IndependentWorkView, OfficialPosition } from "@northstar/db";
import { describe, expect, it } from "vitest";
import type { WorkEntry } from "./independent-work.js";
import { WORK_USAGE, type WorkCliDeps, workCommand } from "./work-cli.js";

// `profile work set|show` (NS-196) with every dependency faked. Invented projects and employer.

const FILE = [
  "Ledgerline | 2026-02 | present",
  "- Built a budgeting app used by 40 testers",
  "",
  "Cloud certification | 2026-01 | 2026-04",
  "- Passed the associate exam",
].join("\n");

const GLOBEX: OfficialPosition = {
  employer: "Globex",
  title: "Engineer",
  startDate: "2019-01",
  endDate: "2025-09",
  current: false,
};

function deps(over: Partial<WorkCliDeps> = {}) {
  const printed: string[] = [];
  const stored: WorkEntry[][] = [];
  const d: WorkCliDeps = {
    print: (line) => printed.push(line),
    readText: async () => FILE,
    readFacts: async () => [GLOBEX],
    setIndependentWork: async (entries) => {
      stored.push(entries);
      return { status: "set", version: 1, entries: entries.length, lines: 2 };
    },
    readIndependentWork: async () => null,
    ...over,
  };
  return { d, printed, stored };
}

describe("profile work linkedin", () => {
  const VIEW: IndependentWorkView = {
    version: 2,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    entries: [
      {
        title: "Cloud certification",
        start: "2026-01",
        end: "2026-04",
        link: null,
        lines: ["Passed the associate exam"],
      },
      {
        title: "Ledgerline",
        start: "2026-02",
        end: null,
        link: "https://example.com/ledgerline",
        lines: ["Built a budgeting app used by 40 testers"],
      },
    ],
  };

  it("prints each project's LinkedIn fields to paste, ongoing first", async () => {
    const { d, printed } = deps({ readIndependentWork: async () => VIEW });
    expect([await workCommand(d, ["linkedin"]), printed]).toEqual([
      0,
      [
        "LinkedIn Projects from version 2. Paste each field; nothing is sent to LinkedIn.",
        "",
        "Project 1",
        "  Name: Ledgerline",
        "  Start: Feb 2026",
        "  End: I am currently working on this",
        "  Project URL: https://example.com/ledgerline",
        "  Description:",
        "  • Built a budgeting app used by 40 testers",
        "",
        "Project 2",
        "  Name: Cloud certification",
        "  Start: Jan 2026",
        "  End: Apr 2026",
        "  Description:",
        "  • Passed the associate exam",
      ],
    ]);
  });

  it("says when a description is over LinkedIn's limit, and still prints it whole", async () => {
    const long = {
      ...VIEW,
      entries: [{ ...VIEW.entries[0], lines: Array.from({ length: 6 }, () => "x".repeat(400)) }],
    } as IndependentWorkView;
    const { d, printed } = deps({ readIndependentWork: async () => long });
    await workCommand(d, ["linkedin"]);
    expect(printed).toContain(
      "  Too long for LinkedIn: 2417 of 2000 characters. Shorten these lines in your file.",
    );
    expect(printed.filter((l) => l.startsWith("  • ")).length).toBe(6);
  });

  it("says when no work is stored yet", async () => {
    const { d, printed } = deps();
    expect([await workCommand(d, ["linkedin"]), printed]).toEqual([
      0,
      ["No independent work stored yet. Run: profile work set data/<file>"],
    ]);
  });
});

describe("profile work set", () => {
  it("stores the parsed file and prints counts only", async () => {
    const { d, printed, stored } = deps();
    const code = await workCommand(d, ["set", "data/work.md"]);
    expect([code, stored.map((s) => s.map((e) => e.title)), printed]).toEqual([
      0,
      [["Ledgerline", "Cloud certification"]],
      ["work.md: stored version 1 (2 entries, 2 lines)."],
    ]);
  });

  it("stores nothing and names each bad line", async () => {
    const { d, printed, stored } = deps({ readText: async () => "Bad header\n- a line" });
    const code = await workCommand(d, ["set", "data/work.md"]);
    expect([code, stored.length, printed]).toEqual([
      1,
      0,
      [
        "work.md: nothing stored. Fix these lines first:",
        "  line 1: a header is: Title | YYYY-MM | YYYY-MM or present [| https link]",
      ],
    ]);
  });

  it("says when the file is unchanged", async () => {
    const { d, printed } = deps({
      setIndependentWork: async () => ({ status: "unchanged", version: 3, entries: 1, lines: 1 }),
    });
    await workCommand(d, ["set", "data/work.md"]);
    expect(printed).toEqual(["work.md: unchanged, still version 3 (1 entry, 1 line)."]);
  });
});

describe("profile work show", () => {
  const stored: IndependentWorkView = {
    version: 2,
    createdAt: new Date("2026-11-26T09:00:00Z"),
    entries: [
      {
        title: "Ledgerline",
        start: "2026-02",
        end: null,
        link: null,
        lines: ["Built a budgeting app used by 40 testers"],
      },
    ],
  };

  it("prints the section, the 20-second answer and where each part came from", async () => {
    const { d, printed } = deps({ readIndependentWork: async () => stored });
    expect([await workCommand(d, ["show"]), printed]).toEqual([
      0,
      [
        "Version 2",
        "",
        "Projects / Independent work",
        "Ledgerline (Feb 2026 – present)",
        "- Built a budgeting app used by 40 testers",
        "",
        "What have you been doing since? (about 20 seconds)",
        "  Since leaving Globex in September 2025, I've been working on Ledgerline. For example: Built a budgeting app used by 40 testers.",
        "  (21 words) From:",
        "  - official record: Globex, ended 2025-09",
        "  - entry 1 (Ledgerline): its title",
        "  - entry 1 (Ledgerline): line 1",
      ],
    ]);
  });

  it("says when the answer can't fit in 20 seconds", async () => {
    const long = Array.from({ length: 50 }, () => "w").join(" ");
    const wordy: IndependentWorkView = {
      ...stored,
      entries: [{ ...stored.entries[0], title: long } as IndependentWorkView["entries"][0]],
    };
    const { d, printed } = deps({ readIndependentWork: async () => wordy });
    await workCommand(d, ["show"]);
    expect(printed.at(-1)).toBe(
      "  It doesn't fit in 20 seconds: shorten the newest entry's title.",
    );
  });

  it("says how to start when nothing is stored", async () => {
    const { d, printed } = deps();
    await workCommand(d, ["show"]);
    expect(printed).toEqual(["No independent work stored yet. Run: profile work set data/<file>"]);
  });

  it("prints its usage for anything else", async () => {
    const { d, printed } = deps();
    expect([await workCommand(d, ["add"]), printed]).toEqual([1, [WORK_USAGE]]);
  });
});
