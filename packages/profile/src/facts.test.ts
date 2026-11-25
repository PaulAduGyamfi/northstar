import type { OfficialPosition } from "@northstar/db";
import { describe, expect, it } from "vitest";
import {
  blocksAutoSubmit,
  type Claim,
  checkEmploymentFacts,
  parseOfficialRecord,
} from "./facts.js";

// Synthetic employers and dates only (the repo is public).
const OFFICIAL: OfficialPosition[] = [
  {
    employer: "Globex",
    title: "Software Engineer",
    startDate: "2019-06-03",
    endDate: "2021-02-28",
    current: false,
  },
  {
    employer: "Globex",
    title: "Senior Software Engineer",
    startDate: "2021-03-01",
    endDate: "2025-11-14",
    current: false,
  },
];

const claim = (over: Partial<Claim> = {}): Claim => ({
  source: "resume",
  employer: "Globex",
  title: "Senior Software Engineer",
  start: "2021-03",
  end: "2025-11",
  current: false,
  ...over,
});

describe("checkEmploymentFacts", () => {
  it("a claim that agrees with the official record has no mismatch", () => {
    expect(checkEmploymentFacts(OFFICIAL, [claim()])).toEqual([]);
  });

  it("reports a different end date as an end mismatch with both values", () => {
    expect(checkEmploymentFacts(OFFICIAL, [claim({ end: "2026-01" })])).toEqual([
      {
        source: "resume",
        employer: "Globex",
        title: "Senior Software Engineer",
        field: "end",
        official: "2025-11-14",
        claimed: "2026-01",
      },
    ]);
  });

  it("reports a job still marked current after the official end as a current mismatch", () => {
    const [m] = checkEmploymentFacts(OFFICIAL, [claim({ end: null, current: true })]);
    expect(m).toMatchObject({ field: "current", official: "ended 2025-11-14", claimed: "present" });
  });

  it("reports a different start date as a start mismatch", () => {
    const [m] = checkEmploymentFacts(OFFICIAL, [claim({ start: "2021-04" })]);
    expect(m).toMatchObject({ field: "start", official: "2021-03-01", claimed: "2021-04" });
  });

  it("compares dates at the precision both sides have", () => {
    expect(checkEmploymentFacts(OFFICIAL, [claim({ start: "2021" })])).toEqual([]);
    expect(checkEmploymentFacts(OFFICIAL, [claim({ start: "2021-03" })])).toEqual([]);
    expect(checkEmploymentFacts(OFFICIAL, [claim({ start: "2021-07" })])).toHaveLength(1);
  });

  it("a date the claim leaves out is not a mismatch", () => {
    expect(checkEmploymentFacts(OFFICIAL, [claim({ start: null, end: null })])).toEqual([]);
  });

  it("matches employers without case, punctuation or a company suffix", () => {
    for (const employer of [
      "GLOBEX, Inc.",
      "Globex Incorporated",
      "Globex LLC",
      "Globex Ltd.",
      "Globex Corp",
      "Globex Corporation",
      "Globex Co.",
      "Globex PLC",
    ]) {
      expect(checkEmploymentFacts(OFFICIAL, [claim({ employer })])).toEqual([]);
    }
  });

  it("matches titles with Sr, Jr and Mgr read as Senior, Junior and Manager", () => {
    expect(checkEmploymentFacts(OFFICIAL, [claim({ title: "Sr. Software Engineer" })])).toEqual([]);
    const official: OfficialPosition[] = [
      {
        employer: "Globex",
        title: "Junior Engineering Manager",
        startDate: "2019-01",
        endDate: "2021-01",
        current: false,
      },
    ];
    expect(
      checkEmploymentFacts(official, [
        claim({ title: "Jr Engineering Mgr", start: null, end: null }),
      ]),
    ).toEqual([]);
  });

  it("reports an employer missing from the official record", () => {
    const [m] = checkEmploymentFacts(OFFICIAL, [claim({ employer: "Initech" })]);
    expect(m).toMatchObject({ field: "employer", official: null, claimed: "Initech" });
  });

  it("reports a title the official record doesn't have for that employer, listing the real ones", () => {
    const [m] = checkEmploymentFacts(OFFICIAL, [claim({ title: "Staff Engineer" })]);
    expect(m).toMatchObject({
      field: "title",
      official: "Software Engineer / Senior Software Engineer",
      claimed: "Staff Engineer",
    });
  });

  it("an official current position claimed as ended is a current mismatch", () => {
    const official: OfficialPosition[] = [
      {
        employer: "Initech",
        title: "Engineer",
        startDate: "2024-01",
        endDate: null,
        current: true,
      },
    ];
    const [m] = checkEmploymentFacts(official, [
      claim({
        employer: "Initech",
        title: "Engineer",
        start: "2024-01",
        end: "2025-06",
        current: false,
      }),
    ]);
    expect(m).toMatchObject({ field: "current", official: "present", claimed: "ended 2025-06" });
  });

  it("compares a rehire's claim against the stint whose start agrees", () => {
    const official: OfficialPosition[] = [
      {
        employer: "Globex",
        title: "Engineer",
        startDate: "2015-01",
        endDate: "2017-06",
        current: false,
      },
      {
        employer: "Globex",
        title: "Engineer",
        startDate: "2020-02",
        endDate: "2023-09",
        current: false,
      },
    ];
    const second = claim({ title: "Engineer", start: "2020-02", end: "2023-09" });
    expect(checkEmploymentFacts(official, [second])).toEqual([]);
  });

  it("two different employers written in a non-Latin script don't match each other", () => {
    const official: OfficialPosition[] = [
      {
        employer: "Глобекс",
        title: "Engineer",
        startDate: "2019-01",
        endDate: "2021-01",
        current: false,
      },
    ];
    const [m] = checkEmploymentFacts(official, [claim({ employer: "Инитех", title: "Engineer" })]);
    expect(m).toMatchObject({ field: "employer", official: null, claimed: "Инитех" });
  });

  it("an employer name with no letters or digits never matches", () => {
    const official: OfficialPosition[] = [
      {
        employer: "???",
        title: "Engineer",
        startDate: "2019-01",
        endDate: "2021-01",
        current: false,
      },
    ];
    const [m] = checkEmploymentFacts(official, [claim({ employer: "!!!", title: "Engineer" })]);
    expect(m).toMatchObject({ field: "employer" });
  });
});

describe("blocksAutoSubmit", () => {
  it("an application form end date that differs from the official one blocks auto-submit", () => {
    const mismatches = checkEmploymentFacts(OFFICIAL, [
      claim({ source: "application_form", end: "2026-01" }),
    ]);
    expect(blocksAutoSubmit(mismatches)).toBe(true);
  });

  it("a resume mismatch alone doesn't block auto-submit", () => {
    const mismatches = checkEmploymentFacts(OFFICIAL, [claim({ end: "2026-01" })]);
    expect(blocksAutoSubmit(mismatches)).toBe(false);
  });
});

describe("parseOfficialRecord", () => {
  it("reads one position per line and skips blank lines and comments", () => {
    const text =
      "# official HR dates\n\nGlobex | Software Engineer | 2019-06-03 | 2021-02-28\nInitech | Engineer | 2024-01 | present\n";
    expect(parseOfficialRecord(text)).toEqual({
      ok: true,
      value: [
        {
          employer: "Globex",
          title: "Software Engineer",
          startDate: "2019-06-03",
          endDate: "2021-02-28",
          current: false,
        },
        {
          employer: "Initech",
          title: "Engineer",
          startDate: "2024-01",
          endDate: null,
          current: true,
        },
      ],
    });
  });

  it("refuses bad lines by line number and returns no positions", () => {
    const text =
      "Globex | Engineer | June 2019 | present\nInitech | Engineer | 2024-01\nAcme | Engineer | 2024-05 | 2024-01\n";
    expect(parseOfficialRecord(text)).toEqual({
      ok: false,
      error: [
        { line: 1, problem: "start must be YYYY-MM or YYYY-MM-DD" },
        { line: 2, problem: "expected 4 fields: employer | title | start | end" },
        { line: 3, problem: "end is before start" },
      ],
    });
  });

  it("compares start and end at the precision both have when checking the order", () => {
    expect(parseOfficialRecord("Globex | Engineer | 2021-06 | 2021-05-31\n")).toEqual({
      ok: false,
      error: [{ line: 1, problem: "end is before start" }],
    });
    expect(parseOfficialRecord("Globex | Engineer | 2021-06-14 | 2021-06\n").ok).toBe(true);
  });

  it("refuses a line with an empty employer or title", () => {
    expect(parseOfficialRecord("Globex |  | 2021-06 | present\n")).toEqual({
      ok: false,
      error: [{ line: 1, problem: "employer and title can't be empty" }],
    });
  });

  it("refuses a record with no positions", () => {
    expect(parseOfficialRecord("# nothing yet\n")).toEqual({
      ok: false,
      error: [{ line: 0, problem: "no positions in the file" }],
    });
  });
});
