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
});
