import { PREFERENCE_DEFAULTS, type PreferenceValues } from "@northstar/db";
import { describe, expect, it } from "vitest";
import { gradeRecruiterMessage, type RecruiterFactsInput } from "./grade.js";

// Synthetic preferences and facts only.
const PREFS: PreferenceValues = {
  ...PREFERENCE_DEFAULTS,
  titles: ["Backend Engineer"],
  seniority: ["Senior"],
  locations: ["Toronto"],
  remote: ["remote"],
  dealbreakers: ["crypto"],
  compFloor: 150_000,
  currency: "USD",
};

const GOOD: RecruiterFactsInput = {
  roleTitle: "Senior Backend Engineer",
  seniority: "Senior",
  company: "Initech",
  location: null,
  remote: "remote",
  salaryMin: 160_000,
  salaryMax: 190_000,
  salaryCurrency: "USD",
  salaryPeriod: "year",
  agency: false,
  personalizedQuote: "I saw your talk on payment retries",
  redFlags: [],
};

const NOTHING: RecruiterFactsInput = {
  ...GOOD,
  roleTitle: null,
  seniority: null,
  company: null,
  remote: null,
  salaryMin: null,
  salaryMax: null,
  salaryCurrency: null,
  salaryPeriod: null,
  agency: null,
  personalizedQuote: null,
};

describe("gradeRecruiterMessage", () => {
  it("grades an exact title above the floor, remote and written for Paul as A", () => {
    expect(gradeRecruiterMessage(GOOD, PREFS)).toEqual({
      grade: "A",
      points: 7,
      reasons: [
        "title:exact",
        "pay:ok",
        "place:ok",
        "sender:in_house",
        "personal:yes",
        "company:named",
      ],
      confidence: "normal",
    });
  });

  it("grades an agency with no pay and a partial title as C", () => {
    const agency: RecruiterFactsInput = {
      ...GOOD,
      roleTitle: "Platform Engineer",
      seniority: null,
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      salaryPeriod: null,
      agency: true,
    };
    expect(gradeRecruiterMessage(agency, PREFS)).toMatchObject({ grade: "C", points: 2 });
  });

  it("grades an onsite role elsewhere with pay below the floor as F", () => {
    const poor: RecruiterFactsInput = {
      ...GOOD,
      remote: "onsite",
      location: "Berlin",
      salaryMin: 90_000,
      salaryMax: 100_000,
    };
    expect(gradeRecruiterMessage(poor, PREFS)).toMatchObject({ grade: "F", points: -2 });
  });

  it("grades a message naming a dealbreaker as F whatever its points", () => {
    const crypto = { ...GOOD, company: "Initech crypto" };
    expect(gradeRecruiterMessage(crypto, PREFS)).toMatchObject({ grade: "F", points: 7 });
    expect(gradeRecruiterMessage(crypto, PREFS).reasons).toContain("dealbreaker");
  });

  it("grades a message asking for an upfront fee as F", () => {
    const scam = { ...GOOD, redFlags: [{ kind: "upfront_fee" as const }] };
    expect(gradeRecruiterMessage(scam, PREFS)).toMatchObject({ grade: "F" });
  });

  it("caps an otherwise good message with a vague role at D", () => {
    const vague = { ...GOOD, redFlags: [{ kind: "vague_role" as const }] };
    expect(gradeRecruiterMessage(vague, PREFS)).toMatchObject({
      grade: "D",
      reasons: expect.arrayContaining(["red_flag:vague_role"]),
    });
  });

  it("marks low confidence when title, pay and place are all unknown", () => {
    expect(gradeRecruiterMessage(NOTHING, PREFS)).toEqual({
      grade: "D",
      points: -1,
      reasons: [
        "title:unknown",
        "pay:unknown",
        "place:unknown",
        "sender:unknown",
        "personal:no",
        "company:unnamed",
      ],
      confidence: "low",
    });
  });

  it("takes a point for a level Paul doesn't want", () => {
    const staff = { ...GOOD, roleTitle: "Staff Backend Engineer", seniority: "Staff" };
    expect(gradeRecruiterMessage(staff, PREFS)).toMatchObject({
      points: 6,
      reasons: expect.arrayContaining(["title:level_mismatch"]),
    });
  });

  it("grades a message naming a dealbreaker only in its text as F", () => {
    const quiet = { ...GOOD, company: null };
    const email = "Senior Backend Engineer at a crypto exchange, remote, $180k per year.";
    expect(gradeRecruiterMessage(quiet, PREFS, email)).toMatchObject({
      grade: "F",
      reasons: expect.arrayContaining(["dealbreaker"]),
    });
  });

  it("grades a message asking for sensitive data as F", () => {
    const scam = { ...GOOD, redFlags: [{ kind: "sensitive_data" as const }] };
    expect(gradeRecruiterMessage(scam, PREFS).grade).toBe("F");
  });

  it("caps an otherwise good message asking for unpaid work at D", () => {
    const unpaid = { ...GOOD, redFlags: [{ kind: "unpaid_work" as const }] };
    expect(gradeRecruiterMessage(unpaid, PREFS).grade).toBe("D");
  });

  it("keeps F when a capped red flag meets a dealbreaker", () => {
    const both = {
      ...GOOD,
      company: "Initech crypto",
      redFlags: [{ kind: "vague_role" as const }],
    };
    expect(gradeRecruiterMessage(both, PREFS).grade).toBe("F");
  });

  it("marks low confidence when exactly two of title, pay and place are unknown", () => {
    const twoUnknown = { ...NOTHING, roleTitle: "Senior Backend Engineer" };
    expect(gradeRecruiterMessage(twoUnknown, PREFS).confidence).toBe("low");
  });

  it("keeps normal confidence when only one of them is unknown", () => {
    const oneUnknown = {
      ...NOTHING,
      roleTitle: "Senior Backend Engineer",
      remote: "remote" as const,
    };
    expect(gradeRecruiterMessage(oneUnknown, PREFS).confidence).toBe("normal");
  });
});

describe("gradeRecruiterMessage with weights learned from Paul's regrades (NS-238 item 3)", () => {
  it("adds each matching reason's adjustment to the points before picking the letter", () => {
    // GOOD scores 7 (A); -2 for in-house and -2 for a personal note leave 3 (B).
    const weighted = gradeRecruiterMessage(GOOD, PREFS, "", {
      "sender:in_house": -2,
      "personal:yes": -2,
      "sender:agency": 2,
    });
    expect([weighted.points, weighted.grade]).toEqual([3, "B"]);
  });

  it("leaves a grade as before with no weights", () => {
    expect(gradeRecruiterMessage(GOOD, PREFS, "", {})).toEqual(gradeRecruiterMessage(GOOD, PREFS));
  });

  it("still caps the letter for a dealbreaker, however the weights lean", () => {
    const crypto = gradeRecruiterMessage(GOOD, PREFS, "a crypto exchange", {
      "title:exact": 2,
      "pay:ok": 2,
    });
    expect(crypto.grade).toBe("F");
  });
});
