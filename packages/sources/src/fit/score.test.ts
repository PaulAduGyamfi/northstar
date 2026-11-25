import { PREFERENCE_DEFAULTS } from "@northstar/db";
import { describe, expect, it } from "vitest";
import { matchRequirements, namesTerm } from "./match.js";
import { jobFingerprint, scoreJob } from "./score.js";
import { JOB, PREFS, PROFILE } from "./test/sample.js";

describe("namesTerm", () => {
  it("finds a technology as a whole name ignoring case", () => {
    expect(namesTerm("5+ years with typescript", "TypeScript")).toBe(true);
  });

  it("doesn't find Go inside Google", () => {
    expect(namesTerm("Experience at Google", "Go")).toBe(false);
  });

  it("doesn't find C inside C# or C++", () => {
    expect([namesTerm("C# and .NET", "C"), namesTerm("Modern C++", "C")]).toEqual([false, false]);
  });

  it("finds a name with symbols such as C# or Node.js", () => {
    expect([namesTerm("C# and .NET", "C#"), namesTerm("Node.js services", "Node.js")]).toEqual([
      true,
      true,
    ]);
  });
});

describe("matchRequirements (MAT-002)", () => {
  it("cites the first atom whose terms the requirement names, with the term", () => {
    const r = matchRequirements([{ text: "PostgreSQL at scale", kind: "must" }], PROFILE);
    expect(r.matched).toEqual([
      { requirement: "PostgreSQL at scale", kind: "must", atomId: "a1", term: "PostgreSQL" },
    ]);
  });

  it("matches a listed skill only through an atom whose text names it", () => {
    const r = matchRequirements(
      [
        { text: "Go services", kind: "must" },
        { text: "Terraform", kind: "nice" },
      ],
      PROFILE,
    );
    expect([r.matched.map((m) => [m.atomId, m.term]), r.unmatched]).toEqual([
      [["a1", "Go"]],
      [{ requirement: "Terraform", kind: "nice" }],
    ]);
  });

  it("leaves a requirement that names no atom's term unmatched", () => {
    const r = matchRequirements([{ text: "Experience at Google", kind: "must" }], PROFILE);
    expect(r).toEqual({
      matched: [],
      unmatched: [{ requirement: "Experience at Google", kind: "must" }],
    });
  });
});

describe("scoreJob (MAT-001, MAT-003)", () => {
  it("scores the sample job 80, queued, with every component", () => {
    const r = scoreJob(JOB, PREFS, PROFILE);
    // 25×1 (title) + 40×3/4 (must-haves) + 10×0 (nice-to-haves) + 25×1 (pay and place) = 80.
    expect([r.score, r.band, r.reason, r.stretch, r.components]).toEqual([
      80,
      "queue",
      "ok",
      false,
      { title: 1, mustHave: 0.75, niceToHave: 0, preference: 1 },
    ]);
  });

  it("lists matched and unmatched requirements as evidence", () => {
    const { evidence } = scoreJob(JOB, PREFS, PROFILE);
    expect([evidence.matched.map((m) => m.atomId), evidence.unmatched]).toEqual([
      ["a1", "a1", "a2"],
      [
        { requirement: "Experience with Rust", kind: "must" },
        { requirement: "Terraform", kind: "nice" },
        { requirement: "Payments experience", kind: "nice" },
      ],
    ]);
  });

  it("skips a job paying below the comp floor", () => {
    const r = scoreJob(JOB, { ...PREFS, compFloor: 200_000 }, PROFILE);
    // Preference fit drops to 1/2 (pay 0, place 1): 25 + 30 + 0 + 12.5 = 67.5, rounded 68.
    expect([r.score, r.band, r.reason, r.evidence.pay]).toEqual([
      68,
      "skip",
      "below_comp_floor",
      { status: "below", yearly: 180_000 },
    ]);
  });

  it("doesn't skip a job whose pay is unknown", () => {
    const job = { ...JOB, salaryMin: null, salaryMax: null };
    const r = scoreJob(job, { ...PREFS, compFloor: 200_000 }, PROFILE);
    expect([r.band, r.evidence.pay.status]).toEqual(["queue", "unknown"]);
  });

  it("converts hourly pay to a year before comparing it with the floor", () => {
    const job = { ...JOB, salaryMin: 70, salaryMax: 80, salaryPeriod: "hour" as const };
    expect(scoreJob(job, PREFS, PROFILE).evidence.pay).toEqual({ status: "ok", yearly: 166_400 });
  });

  it("treats pay in another currency as unknown", () => {
    const job = { ...JOB, salaryCurrency: "EUR" };
    expect(scoreJob(job, PREFS, PROFILE).evidence.pay.status).toBe("unknown");
  });

  it("skips a job that names a dealbreaker", () => {
    const r = scoreJob(JOB, { ...PREFS, dealbreakers: ["kubernetes"] }, PROFILE);
    expect([r.band, r.reason, r.evidence.dealbreaker]).toEqual([
      "skip",
      "dealbreaker",
      "kubernetes",
    ]);
  });

  it("halves the title fit when the job's level isn't one Paul wants", () => {
    const r = scoreJob(JOB, { ...PREFS, seniority: ["Staff"] }, PROFILE);
    // 12.5 + 30 + 0 + 25 = 67.5, rounded 68: suggested.
    expect([r.components.title, r.score, r.band, r.evidence.title]).toEqual([
      0.5,
      68,
      "suggest",
      { status: "exact", levelMismatch: true },
    ]);
  });

  it("gives half title fit for a shared word", () => {
    const r = scoreJob({ ...JOB, title: "Backend Developer" }, PREFS, PROFILE);
    expect([r.components.title, r.evidence.title.status]).toEqual([0.5, "partial"]);
  });

  it("skips below the suggest threshold and names the weakest component", () => {
    const r = scoreJob({ ...JOB, title: "Data Analyst" }, PREFS, PROFILE);
    // 0 + 30 + 0 + 25 = 55 < 60. Title and nice-to-haves are both 0; title comes first.
    expect([r.score, r.band, r.reason]).toEqual([55, "skip", "below_threshold:title"]);
  });

  it("leaves unknown components out of the mean", () => {
    const job = { ...JOB, niceToHaves: [], salaryMin: null, salaryMax: null, remote: null };
    const r = scoreJob({ ...job, location: null }, PREFS, PROFILE);
    // Known: title 1 (25) and must-haves 3/4 (40): (25 + 30) / 65 = 84.6, rounded 85.
    expect([r.components, r.score]).toEqual([
      { title: 1, mustHave: 0.75, niceToHave: null, preference: null },
      85,
    ]);
  });

  it("suggests a job there is nothing to judge by", () => {
    const job = { ...JOB, requirements: [], niceToHaves: [] };
    const r = scoreJob(job, PREFERENCE_DEFAULTS, PROFILE);
    expect([r.score, r.band, r.reason]).toEqual([50, "suggest", "no_evidence"]);
  });

  it("flags a stretch when half to under three quarters of the must-haves are met", () => {
    const job = { ...JOB, requirements: ["TypeScript", "Rust", "Elixir", "Kubernetes"] };
    expect(scoreJob(job, PREFS, PROFILE).stretch).toBe(true);
  });

  it("uses the queue and suggest thresholds Paul set", () => {
    expect(scoreJob(JOB, { ...PREFS, queueAt: 90 }, PROFILE).band).toBe("suggest");
  });
});

describe("jobFingerprint", () => {
  it("is the same for the same fields", () => {
    expect(jobFingerprint({ ...JOB })).toBe(jobFingerprint(JOB));
  });

  it("changes when a scored field changes", () => {
    expect(jobFingerprint({ ...JOB, salaryMax: 190_000 })).not.toBe(jobFingerprint(JOB));
  });

  it("is 64 hex characters", () => {
    expect(jobFingerprint(JOB)).toMatch(/^[0-9a-f]{64}$/);
  });
});
