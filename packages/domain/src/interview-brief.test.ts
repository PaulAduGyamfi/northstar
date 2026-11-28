import { describe, expect, it } from "vitest";
import { buildCompanySnapshot, type SnapshotJob } from "./company-snapshot.js";
import {
  type BriefLine,
  type BriefSources,
  buildInterviewBrief,
  checkInterviewBrief,
} from "./interview-brief.js";

// The interview brief (NS-283 slice 1, CAL-005) for a synthetic interview. Invented names only.

const INTERVIEW_JOB: SnapshotJob = {
  id: "j1",
  title: "Backend Engineer",
  description: "Globex builds billing software for clinics.",
  requirements: ["5+ years of TypeScript", "Experience with PostgreSQL", "On-call experience"],
  postedAt: new Date("2026-11-20T10:00:00Z"),
  closed: false,
};
const OTHER_JOB: SnapshotJob = {
  id: "j2",
  title: "Platform Engineer",
  description: "Run Kubernetes for Globex.",
  requirements: ["Kubernetes in production"],
  postedAt: new Date("2026-11-25T10:00:00Z"),
  closed: false,
};
const JOBS = [INTERVIEW_JOB, OTHER_JOB];
const SOURCES = {
  company: "Globex",
  jobs: JOBS,
  atomIds: new Set(["a1", "a2"]),
  storyIds: new Set(["s1"]),
};

const brief = () =>
  buildInterviewBrief({
    job: INTERVIEW_JOB,
    snapshot: buildCompanySnapshot({ company: "Globex", jobs: JOBS }),
    matched: [
      {
        requirement: "5+ years of TypeScript",
        proof: [
          { source: "story", id: "s1" },
          { source: "atom", id: "a1" },
        ],
      },
      { requirement: "Experience with PostgreSQL", proof: [{ source: "atom", id: "a2" }] },
    ],
    gaps: ["On-call experience"],
  });

describe("buildInterviewBrief", () => {
  it("gives the role, the snapshot, matched must-haves with their proof and the gaps, each cited", () => {
    expect(brief().lines.map((l) => [l.section, l.text, l.cites.map((c) => c.id)])).toEqual([
      ["role", "Backend Engineer", ["j1"]],
      ["about", "Run Kubernetes for Globex.", ["j2"]],
      ["about", "Globex builds billing software for clinics.", ["j1"]],
      ["roles", "Platform Engineer", ["j2"]],
      ["stack", "TypeScript", ["j1"]],
      ["stack", "PostgreSQL", ["j1"]],
      ["stack", "Kubernetes", ["j2"]],
      ["match", "5+ years of TypeScript", ["j1", "s1", "a1"]],
      ["match", "Experience with PostgreSQL", ["j1", "a2"]],
      ["gap", "On-call experience", ["j1"]],
    ]);
  });

  it("leaves out a matched must-have with no proof picked rather than showing it uncited", () => {
    const built = buildInterviewBrief({
      job: INTERVIEW_JOB,
      snapshot: { company: "Globex", about: [], roles: [], stack: [] },
      matched: [{ requirement: "5+ years of TypeScript", proof: [] }],
      gaps: [],
    });
    expect(built.lines.map((l) => l.section)).toEqual(["role"]);
  });
});

describe("checkInterviewBrief", () => {
  it("accepts the brief it built", () => {
    expect(checkInterviewBrief(brief(), SOURCES)).toEqual([]);
  });

  it("refuses an uncited line", () => {
    const uncited: BriefLine = { section: "match", text: "5+ years of TypeScript", cites: [] };
    expect(checkInterviewBrief({ jobId: "j1", lines: [uncited] }, SOURCES)).toEqual([
      { index: 0, reason: "uncited" },
    ]);
  });

  it("refuses an unknown atom, story or job", () => {
    const lines: BriefLine[] = [
      {
        section: "match",
        text: "5+ years of TypeScript",
        cites: [
          { source: "job", id: "j1" },
          { source: "atom", id: "a9" },
        ],
      },
      {
        section: "match",
        text: "5+ years of TypeScript",
        cites: [
          { source: "job", id: "j1" },
          { source: "story", id: "s9" },
        ],
      },
      { section: "gap", text: "On-call experience", cites: [{ source: "job", id: "j9" }] },
    ];
    expect(checkInterviewBrief({ jobId: "j1", lines }, SOURCES)).toEqual([
      { index: 0, reason: "unknown_source" },
      { index: 1, reason: "unknown_source" },
      { index: 2, reason: "unknown_source" },
    ]);
  });

  const check = (line: BriefLine, sources: BriefSources = SOURCES) =>
    checkInterviewBrief({ jobId: "j1", lines: [line] }, sources);
  const j1 = { source: "job" as const, id: "j1" };
  const a1 = { source: "atom" as const, id: "a1" };

  it("refuses a gap that cites proof", () => {
    expect(check({ section: "gap", text: "On-call experience", cites: [j1, a1] })).toEqual([
      { index: 0, reason: "gap_with_proof" },
    ]);
  });

  it("refuses a match with no proof", () => {
    expect(check({ section: "match", text: "5+ years of TypeScript", cites: [j1] })).toEqual([
      { index: 0, reason: "no_proof" },
    ]);
  });

  it("refuses a match the job never asked for", () => {
    expect(check({ section: "match", text: "Led a team of 40", cites: [j1, a1] })).toEqual([
      { index: 0, reason: "not_verbatim" },
    ]);
  });

  it("refuses a role line that isn't the job's title", () => {
    expect(check({ section: "role", text: "Staff Engineer", cites: [j1] })).toEqual([
      { index: 0, reason: "not_verbatim" },
    ]);
  });

  it("refuses a gap taken from another saved job's requirements", () => {
    const line: BriefLine = {
      section: "gap",
      text: "Kubernetes in production",
      cites: [{ source: "job", id: "j2" }],
    };
    expect(check(line)).toEqual([{ index: 0, reason: "other_job" }]);
  });

  it("refuses a snapshot line that cites an atom instead of a job", () => {
    const line: BriefLine = {
      section: "about",
      text: "Globex builds billing software for clinics.",
      cites: [a1],
    };
    expect(check(line)).toEqual([{ index: 0, reason: "not_verbatim" }]);
  });

  it("refuses an about line that doesn't name the company", () => {
    const line: BriefLine = {
      section: "about",
      text: "Run Kubernetes for Globex.",
      cites: [{ source: "job", id: "j2" }],
    };
    expect(check(line, { ...SOURCES, company: "Initech" })).toEqual([
      { index: 0, reason: "off_company" },
    ]);
  });

  it("refuses an other role whose job closed", () => {
    const line: BriefLine = {
      section: "roles",
      text: "Platform Engineer",
      cites: [{ source: "job", id: "j2" }],
    };
    const jobs = [INTERVIEW_JOB, { ...OTHER_JOB, closed: true }];
    expect(check(line, { ...SOURCES, jobs })).toEqual([{ index: 0, reason: "closed_job" }]);
  });

  it("refuses a gap that cites the company's site", () => {
    const line: BriefLine = {
      section: "gap",
      text: "On-call experience",
      cites: [j1, { source: "site", id: "https://globex.example.com/" }],
    };
    const sites = [{ url: "https://globex.example.com/", text: "On-call experience." }];
    expect(check(line, { ...SOURCES, sites })).toEqual([{ index: 0, reason: "not_verbatim" }]);
  });
});
