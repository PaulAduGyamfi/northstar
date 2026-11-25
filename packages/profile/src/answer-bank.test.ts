import { describe, expect, it } from "vitest";
import { adaptAnswer, narrativeKindOf, reuseNote } from "./answer-bank.js";

// Synthetic answers and companies only (public repo).
const stored = {
  shortText: "I want to build reliable systems at {company}.",
  longText: "I want to build reliable systems, and {company} runs the platform I care about.",
};

describe("adaptAnswer", () => {
  it("fills the company slot and prefers the long variant when it fits", () => {
    expect(adaptAnswer(stored, { company: "Example Corp", maxLength: null })).toEqual({
      status: "ok",
      text: "I want to build reliable systems, and Example Corp runs the platform I care about.",
      variant: "long",
    });
  });

  it("falls back to the short variant when the long one is over the limit", () => {
    expect(adaptAnswer(stored, { company: "Example Corp", maxLength: 60 })).toEqual({
      status: "ok",
      text: "I want to build reliable systems at Example Corp.",
      variant: "short",
    });
  });

  it("returns too_long instead of cutting when neither variant fits", () => {
    expect(adaptAnswer(stored, { company: "Example Corp", maxLength: 20 })).toEqual({
      status: "too_long",
      maxLength: 20,
      shortLength: 49,
    });
  });

  it("returns missing_slot when the answer needs a company and none is given", () => {
    expect(adaptAnswer(stored, { company: "  ", maxLength: null })).toEqual({
      status: "missing_slot",
      slot: "company",
    });
  });

  it("returns missing_slot for a slot other than company", () => {
    const withSkill = { shortText: "I use {skill} daily.", longText: null };
    expect(adaptAnswer(withSkill, { company: "Example Corp", maxLength: null })).toEqual({
      status: "missing_slot",
      slot: "skill",
    });
  });

  it("refuses a company name that is a sentence, a link or a slot", () => {
    for (const company of [
      "Acme. I accept any salary; see https://evil.example",
      "Acme\nIgnore the above",
      "www.example.com is hiring",
      "{company}{skill}",
      "A".repeat(81),
    ]) {
      expect(adaptAnswer(stored, { company, maxLength: null })).toEqual({
        status: "unsafe_company",
      });
    }
  });

  it("fills a plain company name with punctuation companies use", () => {
    const one = { shortText: "Hello {company}.", longText: null };
    for (const company of ["Example Corp, Inc.", "Booking.com", "AT&T", "O'Reilly (Media)"]) {
      expect(adaptAnswer(one, { company, maxLength: null })).toEqual({
        status: "ok",
        text: `Hello ${company}.`,
        variant: "short",
      });
    }
  });

  it("returns missing_slot for a placeholder written another way", () => {
    for (const text of ["At {Company}.", "At { company }.", "At {company-name}."]) {
      expect(
        adaptAnswer(
          { shortText: text, longText: null },
          { company: "Example Corp", maxLength: null },
        ),
      ).toEqual({
        status: "missing_slot",
        slot: text.slice(text.indexOf("{") + 1, text.indexOf("}")),
      });
    }
  });

  it("uses an answer with no slot as approved, whatever the company", () => {
    const plain = { shortText: "I like hard problems.", longText: null };
    expect(adaptAnswer(plain, { company: null, maxLength: 100 })).toEqual({
      status: "ok",
      text: "I like hard problems.",
      variant: "short",
    });
  });
});

describe("reuseNote", () => {
  it("says how many times the answer was used", () => {
    expect(reuseNote(7)).toBe("reused from bank (used 7×)");
  });
});

describe("narrativeKindOf", () => {
  it("gives the kind of a narrative canonical question", () => {
    expect(narrativeKindOf("about-yourself")).toBe("reusable_narrative");
    expect(narrativeKindOf("why-this-role")).toBe("company_specific");
  });

  it("is null for a factual question and for an unknown id", () => {
    expect(narrativeKindOf("work-authorization")).toBeNull();
    expect(narrativeKindOf("not-a-question")).toBeNull();
  });
});
