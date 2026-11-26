import { PROFILE_SETTING_FIELDS, QUALIFIED_SETTING_FIELDS } from "@northstar/db";
import { describe, expect, it } from "vitest";
import {
  answerFactual,
  parseQualifier,
  parseSettingValue,
  QUALIFIED_FIELDS,
  type Setting,
} from "./factual.js";
import { FACTUAL_FIELDS } from "./question-canon.js";

// Factual answers from profile settings (NS-141, ANS-001). Synthetic settings only.

const s = (field: string, value: string, qualifier = ""): Setting => ({ field, qualifier, value });

describe("the settings fields", () => {
  it("are the same in packages/db as the question canon's factual fields", () => {
    expect([...PROFILE_SETTING_FIELDS]).toEqual([...FACTUAL_FIELDS]);
  });

  it("are keyed by a qualifier for the same fields in packages/db and here", () => {
    expect([...QUALIFIED_SETTING_FIELDS].sort()).toEqual([...QUALIFIED_FIELDS].sort());
  });
});

describe("parseSettingValue", () => {
  it("normalizes yes/no, years, arrangements, dates and https URLs", () => {
    expect([
      parseSettingValue("needs_sponsorship", "Y"),
      parseSettingValue("years_of_experience", "05"),
      parseSettingValue("work_arrangement", "On-site"),
      parseSettingValue("earliest_start_date", "2027-01-15"),
      parseSettingValue("linkedin_url", "https://www.example.com/in/test"),
    ]).toEqual([
      { ok: true, value: "yes" },
      { ok: true, value: "5" },
      { ok: true, value: "onsite" },
      { ok: true, value: "2027-01-15" },
      { ok: true, value: "https://www.example.com/in/test" },
    ]);
  });

  it("refuses a non-https URL, a negative number, a bad date and a non-yes/no", () => {
    expect([
      parseSettingValue("portfolio_url", "http://example.com"),
      parseSettingValue("portfolio_url", "https://user:pw@example.com"),
      parseSettingValue("years_of_experience", "-3"),
      parseSettingValue("years_of_experience", "5+"),
      parseSettingValue("earliest_start_date", "2027-02-30"),
      parseSettingValue("willing_to_relocate", "maybe"),
      parseSettingValue("work_arrangement", "sometimes"),
      parseSettingValue("notice_period", "two\nweeks"),
    ]).toEqual([
      { ok: false, error: "not_https_url" },
      { ok: false, error: "not_https_url" },
      { ok: false, error: "not_whole_years" },
      { ok: false, error: "not_whole_years" },
      { ok: false, error: "not_iso_date" },
      { ok: false, error: "not_yes_no" },
      { ok: false, error: "not_arrangement" },
      { ok: false, error: "bad_text" },
    ]);
  });
});

describe("parseQualifier and text values", () => {
  it("refuse control characters", () => {
    expect([
      parseSettingValue("notice_period", "2 weeks\u001b[2J"),
      parseQualifier("Go\u0007"),
    ]).toEqual([{ ok: false, error: "bad_text" }, null]);
  });
});

describe("answerFactual", () => {
  const settings = [
    s("work_authorization", "yes", "Canada"),
    s("years_of_experience", "6", "Go"),
    s("years_of_experience", "3", "Rust"),
    s("notice_period", "2 weeks"),
    s("work_arrangement", "hybrid"),
  ];

  it("answers authorization for the stored country with Yes", () => {
    const a = answerFactual("Are you legally authorized to work in Canada?", settings);
    expect(a).toEqual({
      status: "answered",
      answer: "Yes",
      canonical: {
        id: "work-authorization",
        text: "Are you legally authorized to work in {country}?",
      },
      setting: s("work_authorization", "yes", "Canada"),
      confidence: a.status === "answered" ? a.confidence : -1,
      needsReview: true,
    });
  });

  it("does not answer authorization for a country with no stored value", () => {
    const a = answerFactual("Are you legally authorized to work in Germany?", settings);
    expect(a.status === "unanswered" && a.reason).toBe("no_qualifier");
  });

  it("answers years with a skill's stored number", () => {
    const a = answerFactual("How many years of experience do you have with Go?", settings);
    expect(a.status === "answered" && a.answer).toBe("6");
  });

  it("never defaults years for a skill with no value", () => {
    const a = answerFactual("How many years of experience do you have with Python?", settings);
    expect(a.status === "unanswered" && a.reason).toBe("no_qualifier");
  });

  it("matches a skill as a whole word only", () => {
    const a = answerFactual("How many years of experience do you have with Golang?", settings);
    expect(a.status === "unanswered" && a.reason).toBe("no_qualifier");
  });

  it("does not pick one when the question names two stored skills", () => {
    const a = answerFactual("How many years of experience do you have with Go and Rust?", settings);
    expect(a.status === "unanswered" && a.reason).toBe("no_qualifier");
  });

  it("calls a narrative question not factual", () => {
    const a = answerFactual("Tell us about yourself.", settings);
    expect(a).toEqual({ status: "unanswered", reason: "not_factual", canonical: null });
  });

  it("calls a factual field with no setting no_setting", () => {
    const a = answerFactual("What are your salary expectations?", settings);
    expect(a.status === "unanswered" && a.reason).toBe("no_setting");
  });

  it("calls a yes/no question over a text value a form mismatch", () => {
    const a = answerFactual("Are you comfortable working on-site?", settings);
    expect(a.status === "unanswered" && a.reason).toBe("form_mismatch");
  });

  it("answers a choice question with the stored arrangement", () => {
    const a = answerFactual("Do you prefer remote, hybrid or on-site work?", settings);
    expect(a.status === "answered" && a.answer).toBe("Hybrid");
  });

  it("answers a text field with its value", () => {
    const a = answerFactual("What is your notice period?", settings);
    expect(a.status === "answered" && a.answer).toBe("2 weeks");
  });
});
