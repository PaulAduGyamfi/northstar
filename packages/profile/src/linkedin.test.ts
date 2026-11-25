import { describe, expect, it } from "vitest";
import {
  checkLinkedinProvenance,
  describeLinkedinProblem,
  linkedinMonth,
  parseCsv,
  parseLinkedinExport,
} from "./linkedin.js";

// A synthetic export (invented companies and schools; the repo is public).
const POSITIONS = [
  "Company Name,Title,Description,Location,Started On,Finished On",
  'Sample Labs,Founding Engineer,"Shipped production AI agents for claims triage with Python.",Remote,Jun 2025,',
  'Example Payments,Software Engineer,"• Built card-authorization services handling 3,000 requests per second in Java.',
  '• Cut checkout latency by 38% with a ""fast path"" for repeat buyers.",New York,Feb 2021,Apr 2025',
].join("\r\n");
const EDUCATION = [
  "School Name,Start Date,End Date,Notes,Degree Name,Activities",
  "Example State University,2015,2019,,BSc Computer Science,",
].join("\n");
const SKILLS = "Name\nJava\nPython\n\nKafka\n";

describe("parseCsv", () => {
  it("reads quoted fields with commas, doubled quotes and line breaks", () => {
    expect(parseCsv('a,b\n"1, 2","say ""hi""\nthere"\n')).toEqual({
      ok: true,
      value: [
        ["a", "b"],
        ["1, 2", 'say "hi"\nthere'],
      ],
    });
  });

  it("skips blank lines and a byte-order mark", () => {
    expect(parseCsv("﻿Name\r\n\r\nGo\r\n")).toEqual({ ok: true, value: [["Name"], ["Go"]] });
  });

  it("refuses a quote that is never closed", () => {
    expect(parseCsv('a\n"open')).toEqual({ ok: false, error: "unclosed_quote" });
  });
});

describe("linkedinMonth", () => {
  it("keeps the precision LinkedIn gives and never guesses", () => {
    expect(
      [
        "Mar 2021",
        "September 2019",
        "Sept. 2018",
        "2015",
        "",
        "Spring 2020",
        "Mayhem 2020",
        "13/2020",
      ].map(linkedinMonth),
    ).toEqual(["2021-03", "2019-09", "2018-09", "2015", null, null, null, null]);
  });
});

describe("parseLinkedinExport", () => {
  it("turns positions, education and skills into the profile's records", () => {
    const parsed = parseLinkedinExport({
      positions: POSITIONS,
      education: EDUCATION,
      skills: SKILLS,
    });
    if (!parsed.ok) throw new Error(describeLinkedinProblem(parsed.error));
    const x = parsed.value.extract;
    expect(x.roles).toEqual([
      {
        key: "li0",
        employer: "Sample Labs",
        title: "Founding Engineer",
        startMonth: "2025-06",
        endMonth: null,
        current: true,
      },
      {
        key: "li1",
        employer: "Example Payments",
        title: "Software Engineer",
        startMonth: "2021-02",
        endMonth: "2025-04",
        current: false,
      },
    ]);
    expect(x.atoms.map((a) => [a.roleKey, a.sourceQuote])).toEqual([
      ["li0", "Shipped production AI agents for claims triage with Python."],
      ["li1", "Built card-authorization services handling 3,000 requests per second in Java."],
      ["li1", 'Cut checkout latency by 38% with a "fast path" for repeat buyers.'],
    ]);
    expect(x.education).toEqual([
      {
        school: "Example State University",
        degree: "BSc Computer Science",
        field: null,
        startMonth: "2015",
        endMonth: "2019",
      },
    ]);
    expect(x.skills).toEqual(["Java", "Python", "Kafka"]);
    expect(parsed.value.textSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reads columns by name, so their order doesn't matter", () => {
    // The same positions with the columns in reverse order.
    const rows = parseCsv(POSITIONS);
    if (!rows.ok) throw new Error("bad fixture");
    const reversed = rows.value
      .map((r) => r.slice().reverse())
      .map((r) => r.map((f) => `"${f.replaceAll('"', '""')}"`).join(","))
      .join("\n");
    const a = parseLinkedinExport({ positions: POSITIONS });
    const b = parseLinkedinExport({ positions: reversed });
    expect(b.ok && a.ok && b.value.extract).toEqual(a.ok && a.value.extract);
  });

  it("strips a bullet touching its text, keeps a leading minus, and drops punctuation-only lines", () => {
    const positions = [
      "Company Name,Title,Description,Started On,Finished On",
      '"Sample Labs","Engineer","•Built the planner.\n-\n-5% cost after the move.\n- Wrote the runbook.",Jun 2025,',
    ].join("\n");
    const p = parseLinkedinExport({ positions });
    expect(p.ok && p.value.extract.atoms.map((a) => a.sourceQuote)).toEqual([
      "Built the planner.",
      "-5% cost after the move.",
      "Wrote the runbook.",
    ]);
  });

  it("gives the same hash for the same files and a new one when a file changes", () => {
    const hash = (files: Parameters<typeof parseLinkedinExport>[0]) => {
      const p = parseLinkedinExport(files);
      return p.ok ? p.value.textSha256 : null;
    };
    const a = hash({ positions: POSITIONS, skills: SKILLS });
    expect([
      a === hash({ positions: POSITIONS, skills: SKILLS }),
      a === hash({ positions: POSITIONS }),
    ]).toEqual([true, false]);
  });

  it("refuses an export missing a required column, naming the file and column", () => {
    const parsed = parseLinkedinExport({ positions: "Company Name,Title\nSample Labs,Engineer" });
    expect(parsed).toEqual({
      ok: false,
      error: { kind: "missing_header", file: "Positions.csv", header: "Description" },
    });
    expect(parsed.ok ? "" : describeLinkedinProblem(parsed.error)).toBe(
      'Positions.csv has no "Description" column',
    );
  });

  it("refuses broken CSV in an optional file too, and an export with no positions", () => {
    expect([
      parseLinkedinExport({ positions: POSITIONS, skills: 'Name\n"Go' }),
      parseLinkedinExport({ positions: "Company Name,Title,Description,Started On,Finished On\n" }),
    ]).toEqual([
      { ok: false, error: { kind: "bad_csv", file: "Skills.csv" } },
      { ok: false, error: { kind: "no_positions" } },
    ]);
  });
});

describe("checkLinkedinProvenance", () => {
  const rows = [
    { "Company Name": "Sample Labs", Title: "Engineer", Description: "Built the planner." },
  ];
  const extract = () => ({
    roles: [
      {
        key: "li0",
        employer: "Sample Labs",
        title: "Engineer",
        startMonth: null,
        endMonth: null,
        current: true,
      },
    ],
    education: [],
    atoms: [
      {
        roleKey: "li0",
        what: "Built the planner.",
        how: [],
        impact: null,
        scope: null,
        startMonth: null,
        endMonth: null,
        sourceQuote: "Built the planner.",
        evidenceLink: null,
      },
    ],
    skills: [],
    certifications: [],
    links: [],
  });

  it("passes an extract built from its rows", () => {
    expect(checkLinkedinProvenance(extract(), rows)).toEqual([]);
  });

  it("refuses a quote its Description doesn't hold, and a role that isn't its row", () => {
    const x = extract();
    x.atoms[0] = {
      ...x.atoms[0],
      sourceQuote: "Built the planner for 40 depots.",
    } as (typeof x.atoms)[0];
    x.roles[0] = { ...x.roles[0], title: "Lead Engineer" } as (typeof x.roles)[0];
    expect(checkLinkedinProvenance(x, rows)).toEqual([
      { kind: "role_not_its_row", position: 0 },
      { kind: "quote_not_in_description", position: 0 },
    ]);
  });
});
