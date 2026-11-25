import { describe, expect, it } from "vitest";
import { checkThesis, type ThesisEvidence, yearsOfExperience } from "./thesis.js";

// Synthetic evidence (invented employers, public repo).
const evidence: ThesisEvidence = {
  quotes: [
    "Built card-authorization services handling 3,000 requests per second in Java.",
    "Shipped production AI agents for claims triage with Python.",
  ],
  roles: [
    {
      employer: "Example Payments",
      title: "Software Engineer",
      startMonth: "2021-02",
      endMonth: "2025-04",
      current: false,
    },
    {
      employer: "Sample Labs",
      title: "Founding Engineer",
      startMonth: "2025-06",
      endMonth: null,
      current: true,
    },
  ],
  skills: ["Java", "Python", "Kafka"],
  asOf: "2026-11",
};

describe("checkThesis", () => {
  it("passes a thesis its quotes, roles and skills back up", () => {
    const text =
      "Software engineer with 5 years of payments scale at Example Payments who now ships production AI agents in Python.";
    expect(checkThesis(text, evidence, 2)).toEqual([]);
  });

  it("refuses a thesis that cites no atom", () => {
    expect(checkThesis("Engineer who ships AI agents.", evidence, 0)).toEqual([
      { kind: "no_citation" },
    ]);
  });

  it("refuses a number no quote states", () => {
    expect(
      checkThesis("Engineer who scaled payments to 10,000 requests per second.", evidence, 1),
    ).toEqual([{ kind: "unbacked_number", token: "10,000" }]);
  });

  it("refuses more years of experience than the roles span", () => {
    expect(yearsOfExperience(evidence.roles, evidence.asOf)).toBe(5);
    expect(checkThesis("Engineer with 7 years of payments work.", evidence, 1)).toEqual([
      { kind: "unbacked_number", token: "7" },
    ]);
    expect(checkThesis("Engineer with 5+ years of payments work.", evidence, 1)).toEqual([]);
  });

  it("doesn't let career years back years of a named technology or another count", () => {
    expect(checkThesis("Engineer with 5 years of Kafka.", evidence, 1)).toEqual([
      { kind: "unbacked_number", token: "5" },
    ]);
    expect(checkThesis("Engineer who led 1 team for 1 year.", evidence, 1)).toEqual([
      { kind: "unbacked_number", token: "1" },
    ]);
  });

  it("checks the first word too", () => {
    expect(checkThesis("Globex engineer who builds Java services.", evidence, 1)).toEqual([
      { kind: "unbacked_name", token: "Globex" },
    ]);
  });

  it("refuses a company or technology the evidence doesn't name", () => {
    expect(
      checkThesis("Engineer from Example Payments who runs Kubernetes for Globex.", evidence, 1),
    ).toEqual([
      { kind: "unbacked_name", token: "Kubernetes" },
      { kind: "unbacked_name", token: "Globex" },
    ]);
  });

  it("matches names as whole words, so Java doesn't back JavaScript", () => {
    expect(checkThesis("Engineer who writes JavaScript.", evidence, 1)).toEqual([
      { kind: "unbacked_name", token: "JavaScript" },
    ]);
  });

  it("refuses two sentences, an empty text and an over-long one", () => {
    expect(checkThesis("Engineer at Example Payments. Builds AI agents.", evidence, 1)).toEqual([
      { kind: "not_one_sentence" },
    ]);
    expect(checkThesis("   ", evidence, 1)).toEqual([{ kind: "not_one_sentence" }]);
    expect(checkThesis(`Engineer ${"x".repeat(200)}`, evidence, 1)).toEqual([
      { kind: "not_one_sentence" },
    ]);
    expect(checkThesis("Engineer\nwho ships agents", evidence, 1)).toEqual([
      { kind: "not_one_sentence" },
    ]);
    expect(checkThesis("Engineer\rwho ships agents", evidence, 1)).toEqual([
      { kind: "not_one_sentence" },
    ]);
  });
});

describe("yearsOfExperience", () => {
  it("counts overlapping roles once and a year-only date from January", () => {
    const roles = [
      { employer: "A", title: "T", startMonth: "2020", endMonth: "2022-12", current: false },
      { employer: "B", title: "T", startMonth: "2022-01", endMonth: "2023-12", current: false },
    ];
    expect(yearsOfExperience(roles, "2026-01")).toBe(4);
  });

  it("counts a year-only end date from January, the shortest span it can mean", () => {
    const roles = [
      { employer: "A", title: "T", startMonth: "2019", endMonth: "2022", current: false },
    ];
    expect(yearsOfExperience(roles, "2026-01")).toBe(3);
  });
});
