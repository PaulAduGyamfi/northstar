import { describe, expect, it } from "vitest";
import {
  fitWords,
  jobRow,
  jobsForRole,
  postedWords,
  reasonWords,
  roleHeading,
  safeLink,
  whyLines,
} from "./jobs";

// The jobs page's words (NS-130 slice 10). Invented companies only.
describe("postedWords", () => {
  it("says how long ago a job was posted in hours, then days", () => {
    expect([0, 3, 23, 24, 50].map(postedWords)).toEqual([
      "Posted in the last hour",
      "Posted 3 h ago",
      "Posted 23 h ago",
      "Posted yesterday",
      "Posted 2 days ago",
    ]);
  });
});

describe("fitWords", () => {
  it("says the score and band in words, a stretch, or that it isn't scored", () => {
    expect([
      fitWords({ score: 88, band: "queue", reason: "ok", stretch: false }),
      fitWords({ score: 64, band: "suggest", reason: "ok", stretch: true }),
      fitWords({ score: 30, band: "skip", reason: "below_threshold:mustHave", stretch: false }),
      fitWords(null),
    ]).toEqual([
      "Fit 88 · in the queue",
      "Fit 64 · suggested · a stretch",
      "Fit 30 · below your bar (weakest on must-have skills)",
      "Not scored yet",
    ]);
  });
});

describe("reasonWords", () => {
  it("says why a job got its band, and leaves out a code it doesn't know", () => {
    expect(
      [
        "ok",
        "dealbreaker",
        "below_comp_floor",
        "no_evidence",
        "below_threshold:title",
        "below_threshold:other",
        "weird",
        null,
      ].map(reasonWords),
    ).toEqual([
      null,
      "matches one of your dealbreakers",
      "pay is below your floor",
      "nothing on your resume to match yet",
      "weakest on the title",
      null,
      null,
      null,
    ]);
  });
});

describe("jobRow", () => {
  it("joins company, place and remote kind, and keeps an https link", () => {
    expect(
      jobRow({
        rank: 2,
        title: "Backend Engineer",
        company: "Initech",
        location: "New York, NY",
        remote: "hybrid",
        ageHours: 5,
        fit: { score: 80, band: "queue", reason: "ok", stretch: false },
        url: "https://boards.greenhouse.io/initech/jobs/1",
      }),
    ).toEqual({
      key: "2",
      title: "Backend Engineer",
      where: "Initech · New York, NY · Hybrid",
      posted: "Posted 5 h ago",
      fit: "Fit 80 · in the queue",
      why: [],
      link: "https://boards.greenhouse.io/initech/jobs/1",
    });
  });

  it("names a job with no title, company or place plainly", () => {
    const row = jobRow({
      rank: 1,
      title: null,
      company: null,
      location: null,
      remote: null,
      ageHours: 0,
      fit: null,
      url: null,
    });
    expect([row.title, row.where, row.link]).toEqual([
      "Untitled job",
      "Company and place unknown",
      null,
    ]);
  });
});

describe("whyLines (NS-130 slice 11, UX-014)", () => {
  const why = {
    title: "partial",
    levelMismatch: true,
    pay: "below",
    place: "ok",
    mustHave: { matched: 4, total: 6 },
    missing: ["Kubernetes", "Terraform"],
    dealbreaker: true,
  };

  it("words each check, the must-haves and what the experience doesn't show", () => {
    expect(whyLines(why)).toEqual([
      "Title: close to your target titles, at a level you didn't list",
      "Pay: below your floor",
      "Place: fits your locations",
      "Must-haves: 4 of 6 backed by your experience",
      "Not shown in your experience: Kubernetes, Terraform",
      "Matches one of your dealbreakers",
    ]);
  });

  it("leaves out an unknown code and a job with no must-haves listed", () => {
    expect(
      whyLines({
        ...why,
        title: "sideways",
        levelMismatch: false,
        pay: "unknown",
        place: "elsewhere",
        mustHave: { matched: 0, total: 0 },
        missing: [],
        dealbreaker: false,
      }),
    ).toEqual(["Pay: not stated"]);
  });

  it("gives no lines when the API sent no why, or none at all", () => {
    expect([whyLines(null), whyLines(undefined)]).toEqual([[], []]);
  });
});

describe("safeLink", () => {
  it("renders only https links, whatever the API sent", () => {
    expect([
      safeLink("https://jobs.example.com/1"),
      safeLink("javascript:alert(1)"),
      safeLink("http://jobs.example.com/1"),
      safeLink(null),
    ]).toEqual(["https://jobs.example.com/1", null, null, null]);
  });
});

describe("jobsForRole", () => {
  it("links a direction to its jobs with the role encoded", () => {
    expect(jobsForRole("c++ engineer & lead")).toBe("/jobs?role=c%2B%2B%20engineer%20%26%20lead");
  });
});

describe("roleHeading", () => {
  it("names the role a filtered list shows", () => {
    expect(roleHeading("backend engineer")).toBe("Jobs for backend engineer");
  });
});
