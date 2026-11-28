import { describe, expect, it } from "vitest";
import { buildCompanySnapshot, type SnapshotJob } from "./company-snapshot.js";
import { type BriefLine, buildInterviewBrief, checkInterviewBrief } from "./interview-brief.js";

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
const SOURCES = { jobs: JOBS, atomIds: new Set(["a1", "a2"]), storyIds: new Set(["s1"]) };

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

  it("refuses a gap that cites proof, a match with none, and a line the job never asked for", () => {
    const lines: BriefLine[] = [
      {
        section: "gap",
        text: "On-call experience",
        cites: [
          { source: "job", id: "j1" },
          { source: "atom", id: "a1" },
        ],
      },
      { section: "match", text: "5+ years of TypeScript", cites: [{ source: "job", id: "j1" }] },
      {
        section: "match",
        text: "Led a team of 40",
        cites: [
          { source: "job", id: "j1" },
          { source: "atom", id: "a1" },
        ],
      },
      { section: "role", text: "Staff Engineer", cites: [{ source: "job", id: "j1" }] },
    ];
    expect(checkInterviewBrief({ jobId: "j1", lines }, SOURCES)).toEqual([
      { index: 0, reason: "gap_with_proof" },
      { index: 1, reason: "no_proof" },
      { index: 2, reason: "not_verbatim" },
      { index: 3, reason: "not_verbatim" },
    ]);
  });

  it("refuses a snapshot line that cites an atom instead of a job", () => {
    const line: BriefLine = {
      section: "about",
      text: "Globex builds billing software for clinics.",
      cites: [{ source: "atom", id: "a1" }],
    };
    expect(checkInterviewBrief({ jobId: "j1", lines: [line] }, SOURCES)).toEqual([
      { index: 0, reason: "not_verbatim" },
    ]);
  });
});
