import type { ScoringProfile } from "@northstar/db";
import { describe, expect, it } from "vitest";
import { careerDirections, type DirectionJob, roleFamily } from "./directions.js";

// Synthetic profile and jobs (invented work and companies, public repo).
const profile: ScoringProfile = {
  sourceId: "src-1",
  atoms: [
    { id: "a-go", what: "Built the billing service.", how: ["Go"] },
    { id: "a-pg", what: "Tuned the ledger database.", how: ["PostgreSQL"] },
  ],
  skills: [],
};

const now = new Date("2026-11-27T00:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

function job(id: string, title: string | null, requirements: string[], posted = 30): DirectionJob {
  return { id, title, requirements, postedAt: daysAgo(posted) };
}

describe("roleFamily", () => {
  it("drops seniority words and the part after a comma, dash, bar or bracket", () => {
    expect(roleFamily("Senior Backend Engineer (Payments)")).toBe("backend engineer");
    expect(roleFamily("Backend Engineer II")).toBe("backend engineer");
    expect(roleFamily("Staff Backend Engineer - Ledger")).toBe("backend engineer");
    expect(roleFamily("Backend Engineer, Platform")).toBe("backend engineer");
    expect(roleFamily("Sr. Backend Engineer | Remote")).toBe("backend engineer");
    expect(roleFamily("Senior Backend Engineer – Payments")).toBe("backend engineer");
    expect(roleFamily("Backend Engineer — Ledger")).toBe("backend engineer");
  });

  it("reads only the first 200 characters of a title, so a hostile one returns at once", () => {
    const hostile = `Backend Engineer a${"!".repeat(100_000)}b`;
    const started = performance.now();
    expect(roleFamily(hostile)).toBe("backend engineer a");
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("gives no family for a missing title or one made only of seniority words", () => {
    expect(roleFamily(null)).toBeNull();
    expect(roleFamily("Senior (Contract)")).toBeNull();
  });
});

describe("careerDirections", () => {
  it("leaves out a family with only one job", () => {
    const jobs = [job("j1", "Data Engineer", ["Go"])];
    expect(careerDirections(jobs, profile, now)).toEqual([]);
  });

  it("gives a family's coverage as matched over all its must-haves, with the atoms that matched", () => {
    const jobs = [
      // PostgreSQL first, so the atoms' order comes from the sort by count, not first seen.
      job("j1", "Senior Backend Engineer", ["PostgreSQL tuning", "Kafka"]),
      job("j2", "Backend Engineer II", ["Go services", "Go APIs", "Rust"]),
    ];
    const [d] = careerDirections(jobs, profile, now);
    expect(d).toMatchObject({
      role: "backend engineer",
      jobCount: 2,
      coverage: 60,
      evidence: [
        { atomId: "a-go", requirements: 2 },
        { atomId: "a-pg", requirements: 1 },
      ],
    });
  });

  it("lists the five most frequent unmatched must-haves, ties by first seen", () => {
    const jobs = [
      job("j1", "Backend Engineer", ["Kafka", "Rust", "gRPC", "Terraform", "AWS", "Redis"]),
      job("j2", "Backend Engineer", ["Redis", "Kafka"]),
    ];
    const [d] = careerDirections(jobs, profile, now);
    expect(d?.gaps).toEqual([
      { requirement: "Kafka", jobs: 2 },
      { requirement: "Redis", jobs: 2 },
      { requirement: "Rust", jobs: 1 },
      { requirement: "gRPC", jobs: 1 },
      { requirement: "Terraform", jobs: 1 },
    ]);
  });

  it("counts the same gap worded with different case and spacing as one", () => {
    const jobs = [
      job("j1", "Backend Engineer", ["Kafka "]),
      job("j2", "Backend Engineer", ["kafka"]),
    ];
    expect(careerDirections(jobs, profile, now)[0]?.gaps).toEqual([
      { requirement: "Kafka", jobs: 2 },
    ]);
  });

  it("counts a requirement a job lists twice as one gap for that job, and skips a blank one", () => {
    const jobs = [
      job("j1", "Backend Engineer", ["Kafka", "kafka", "  "]),
      job("j2", "Backend Engineer", ["Go"]),
    ];
    expect(careerDirections(jobs, profile, now)[0]?.gaps).toEqual([
      { requirement: "Kafka", jobs: 1 },
    ]);
  });

  it("never counts a job dated after now as fresh", () => {
    const jobs = [
      job("future", "Backend Engineer", ["Go"], -1),
      job("today", "Backend Engineer", ["Go"], 0),
    ];
    expect(careerDirections(jobs, profile, now)[0]?.freshJobIds).toEqual(["today"]);
  });

  it("lists the fresh jobs posted within seven days, freshest first, and never an undated one", () => {
    const jobs: DirectionJob[] = [
      job("old", "Backend Engineer", ["Go"], 8),
      job("two", "Backend Engineer", ["Go"], 2),
      job("one", "Backend Engineer", ["Go"], 1),
      job("seven", "Backend Engineer", ["Go"], 7),
      { id: "undated", title: "Backend Engineer", requirements: ["Go"], postedAt: null },
    ];
    expect(careerDirections(jobs, profile, now)[0]?.freshJobIds).toEqual(["one", "two", "seven"]);
  });

  it("ranks by coverage, then fresh jobs, then all jobs, then name, with no must-haves last", () => {
    const jobs = [
      // "platform engineer": no must-haves.
      job("p1", "Platform Engineer", []),
      job("p2", "Platform Engineer", []),
      // "data engineer": 50 %, no fresh jobs.
      job("d1", "Data Engineer", ["Go", "Kafka"]),
      job("d2", "Data Engineer", ["Go", "Kafka"]),
      // "api engineer": 50 %, one fresh job.
      job("x1", "API Engineer", ["Go", "Kafka"], 1),
      job("x2", "API Engineer", ["Go", "Kafka"]),
      // "backend engineer": 100 %.
      job("b1", "Backend Engineer", ["Go"]),
      job("b2", "Backend Engineer", ["PostgreSQL"]),
      // "web engineer": 50 %, one fresh job, three jobs.
      job("w1", "Web Engineer", ["Go", "Kafka"], 1),
      job("w2", "Web Engineer", ["Go", "Kafka"]),
      job("w3", "Web Engineer", ["Go", "Kafka"]),
      // "zeta engineer": the same as "api engineer" but a later name.
      job("z1", "Zeta Engineer", ["Go", "Kafka"], 1),
      job("z2", "Zeta Engineer", ["Go", "Kafka"]),
    ];
    expect(careerDirections(jobs, profile, now).map((d) => [d.role, d.coverage])).toEqual([
      ["backend engineer", 100],
      ["web engineer", 50],
      ["api engineer", 50],
      ["zeta engineer", 50],
      ["data engineer", 50],
      ["platform engineer", null],
    ]);
  });

  it("gives no directions for no jobs, and zero coverage when the profile has no atoms", () => {
    expect(careerDirections([], profile, now)).toEqual([]);
    const jobs = [job("j1", "Backend Engineer", ["Go"]), job("j2", "Backend Engineer", ["Go"])];
    const [d] = careerDirections(jobs, { sourceId: "s", atoms: [], skills: [] }, now);
    expect(d?.coverage).toBe(0);
    expect(d?.evidence).toEqual([]);
  });
});
