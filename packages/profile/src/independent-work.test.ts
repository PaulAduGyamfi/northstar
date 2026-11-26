import { describe, expect, it } from "vitest";
import {
  independentWorkSection,
  MAX_ANSWER_WORDS,
  parseIndependentWork,
  sinceFromFacts,
  twentySecondAnswer,
  type WorkEntry,
} from "./independent-work.js";

// Gap-to-proof (NS-196, DX-010). Invented projects and an invented employer only.

const FILE = [
  "Ledgerline | 2026-02 | present | https://example.com/ledgerline",
  "- Built a budgeting app used by 40 testers",
  "- Shipped weekly releases for 12 weeks",
  "",
  "Cloud certification | 2026-01 | 2026-04",
  "- Passed the associate exam on the first try",
].join("\n");

const entries = (): WorkEntry[] => {
  const parsed = parseIndependentWork(FILE);
  if (!parsed.ok) throw new Error("fixture didn't parse");
  return parsed.value;
};

describe("parseIndependentWork", () => {
  it("reads each entry's title, months, link and lines", () => {
    expect(entries()).toEqual([
      {
        title: "Ledgerline",
        start: "2026-02",
        end: null,
        link: "https://example.com/ledgerline",
        lines: ["Built a budgeting app used by 40 testers", "Shipped weekly releases for 12 weeks"],
      },
      {
        title: "Cloud certification",
        start: "2026-01",
        end: "2026-04",
        link: null,
        lines: ["Passed the associate exam on the first try"],
      },
    ]);
  });

  it("reports every problem with its line number and returns no entries", () => {
    const bad = [
      "No months here",
      "- orphaned by the bad header",
      "",
      "Late | 2026-05 | 2026-03",
      "- ends before it starts",
      "",
      "Linked | 2026-01 | present | http://example.com",
      "- plain http",
      "",
      "Empty | 2026-01 | present",
      "",
      "- a line with no header",
      "",
      `${"T".repeat(81)} | 2026-01 | present`,
      "- long title",
      "",
      "Fine | 2026-01 | present",
      `- ${"x".repeat(201)}`,
      "not a bullet",
    ].join("\n");
    const result = parseIndependentWork(bad);
    expect(result.ok ? [] : result.error.map((p) => p.line)).toEqual([
      1, 4, 7, 10, 12, 14, 17, 18, 19,
    ]);
  });

  it("refuses an entry with more than six lines, and a file with nothing in it", () => {
    const seven = ["Busy | 2026-01 | present", ...Array.from({ length: 7 }, (_, i) => `- l${i}`)];
    expect([parseIndependentWork(seven.join("\n")), parseIndependentWork("\n\n")]).toEqual([
      { ok: false, error: [{ line: 1, problem: "an entry has at most 6 lines" }] },
      { ok: false, error: [{ line: 1, problem: "the file has no entries" }] },
    ]);
  });

  it("refuses a link the database wouldn't store, with its line number", () => {
    const links = [
      "HTTPS://example.com",
      "https:example.com",
      "https:/example.com",
      "https://example.com/a\tb",
    ];
    expect(
      links.map((link) => {
        const r = parseIndependentWork(`X | 2026-01 | present | ${link}\n- a`);
        return r.ok ? "accepted" : r.error[0]?.line;
      }),
    ).toEqual([1, 1, 1, 1]);
  });

  it("refuses a month that isn't one, and a tab inside a title or line", () => {
    const files = [
      "X | 2026-13 | present\n- a",
      "X | 2026-01 | 2026-00\n- a",
      "Tab\there | 2026-01 | present\n- a",
      "X | 2026-01 | present\n- a\tb",
    ];
    expect(
      files.map((f) => {
        const r = parseIndependentWork(f);
        return r.ok ? "accepted" : r.error.map((p) => p.line);
      }),
    ).toEqual([[1], [1], [1], [1, 2]]);
  });

  it("refuses a link with a user name in it", () => {
    const result = parseIndependentWork("X | 2026-01 | present | https://me:pw@example.com\n- a");
    expect(result.ok).toBe(false);
  });
});

describe("independentWorkSection", () => {
  it("puts ongoing work first and quotes each line verbatim", () => {
    expect(independentWorkSection(entries())).toEqual([
      "Projects / Independent work",
      "Ledgerline (Feb 2026 – present)",
      "- Built a budgeting app used by 40 testers",
      "- Shipped weekly releases for 12 weeks",
      "Cloud certification (Jan 2026 – Apr 2026)",
      "- Passed the associate exam on the first try",
    ]);
  });
});

describe("sinceFromFacts", () => {
  it("is the latest ended position, and nothing while one is ongoing", () => {
    const record = [
      { employer: "Initech", endDate: "2019-06", current: false },
      { employer: "Globex", endDate: "2025-09-30", current: false },
    ];
    expect([
      sinceFromFacts(record),
      sinceFromFacts([...record, { employer: "Acme", endDate: null, current: true }]),
      sinceFromFacts([]),
    ]).toEqual([{ employer: "Globex", month: "2025-09" }, null, null]);
  });
});

describe("twentySecondAnswer", () => {
  it("names the gap, the work and one of Paul's lines, and its sources", () => {
    const answer = twentySecondAnswer(entries(), { employer: "Globex", month: "2025-09" });
    expect(answer).toEqual({
      ok: true,
      text: "Since leaving Globex in September 2025, I've been working on Ledgerline and Cloud certification. For example: Built a budgeting app used by 40 testers.",
      words: 24,
      sources: [
        { part: "since", employer: "Globex", month: "2025-09" },
        { part: "title", entry: 0 },
        { part: "title", entry: 1 },
        { part: "example", entry: 0, line: 0 },
      ],
    });
  });

  it("drops later titles, then the example, to stay within the word limit", () => {
    const long = (n: number): WorkEntry => ({
      title: `Project ${n} with a deliberately long and wordy name`,
      start: `2026-0${n}`,
      end: null,
      link: null,
      lines: ["A line of proof that runs on for quite a few words to take up room"],
    });
    const four = [long(1), long(2), long(3), long(4)];
    const answer = twentySecondAnswer(four, null);
    const wordy = { ...long(5), lines: [Array.from({ length: 50 }, () => "word").join(" ")] };
    const noExample = twentySecondAnswer([wordy], null);
    expect([
      answer.ok && answer.words <= MAX_ANSWER_WORDS,
      answer.ok && answer.sources,
      noExample.ok && noExample.sources,
    ]).toEqual([
      true,
      [
        { part: "title", entry: 3 },
        { part: "title", entry: 2 },
        { part: "title", entry: 1 },
        { part: "example", entry: 3, line: 0 },
      ],
      [{ part: "title", entry: 0 }],
    ]);
  });

  it("uses no words but fixed ones, the record's, and Paul's own", () => {
    const answer = twentySecondAnswer(entries(), { employer: "Globex", month: "2025-09" });
    const allowed = new Set(
      [
        "Since leaving in September 2025, I've been working on and . For example:",
        "Globex",
        ...entries().flatMap((e) => [e.title, ...e.lines]),
      ]
        .join(" ")
        .split(/[\s,.:]+/),
    );
    const used = answer.ok ? answer.text.split(/[\s,.:]+/).filter(Boolean) : ["missing"];
    expect(used.filter((w) => !allowed.has(w))).toEqual([]);
  });

  it("says it doesn't fit when even one title and the opener are too long", () => {
    const wordy: WorkEntry = {
      title: Array.from({ length: 50 }, () => "w").join(" "),
      start: "2026-01",
      end: null,
      link: null,
      lines: ["a"],
    };
    expect(twentySecondAnswer([wordy], { employer: "Globex", month: "2025-09" })).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  it("says there is nothing yet when there are no entries", () => {
    expect(twentySecondAnswer([], null)).toEqual({ ok: false, reason: "no_entries" });
  });
});
