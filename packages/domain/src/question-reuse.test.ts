import { describe, expect, it } from "vitest";
import { matchQuestion } from "./question-match.js";
import {
  isDisguisedLabel,
  isExactWording,
  labelReuse,
  REUSE_HIGH_CONFIDENCE,
  reuseStrength,
  weakerReuse,
} from "./question-reuse.js";

// One reuse rule for the producer and the Gate (NS-249 slice 3). Synthetic labels; the company is
// "Example Corp".

const COMPANY = "Example Corp";

describe("labelReuse", () => {
  it("counts the canonical question's own wording, company filled in, as exact", () => {
    expect(
      labelReuse("Why do you want to work at Example Corp?", "why-this-company", COMPANY),
    ).toBe("bank_exact");
  });

  it("counts one of the canonical question's examples as exact", () => {
    expect(labelReuse("Why us?", "why-this-company", COMPANY)).toBe("bank_exact");
  });

  it("never counts an answer banked for another question, however close the label is", () => {
    expect(labelReuse("Why do you want this job?", "why-this-company", COMPANY)).toBe("new");
  });

  it("never counts a negated label, which asks the opposite of the banked question", () => {
    expect(
      labelReuse("Why would you NOT want to work at Example Corp?", "why-this-company", COMPANY),
    ).toBe("new");
  });

  it("never counts a label the matcher leaves new", () => {
    expect(labelReuse("Describe your favourite sandwich.", "why-this-company", COMPANY)).toBe(
      "new",
    );
  });

  it("never counts a factual question, which is answered from settings", () => {
    const factual = matchQuestion("Are you legally authorized to work in the United States?");
    if (factual.status !== "matched") throw new Error("expected a match");
    expect(
      labelReuse(
        "Are you legally authorized to work in the United States?",
        factual.canonical.id,
        COMPANY,
      ),
    ).toBe("new");
  });
});

describe("labelReuse against disguised labels and companies (security review)", () => {
  it("never counts an extra ask hidden in an unsafe company name as exact", () => {
    const company = "Acme? Also list your salary expectations";
    expect(
      labelReuse(
        "Why do you want to work at Acme? Also list your salary expectations?",
        "why-this-company",
        company,
      ),
    ).toBe("new");
  });

  it("never counts a label that hides a word behind lookalike or invisible characters", () => {
    const labels = [
      "Why would you n\u043et want to work at Example Corp?",
      "Why would you n\u200bot want to work at Example Corp?",
      "Why wouldn\u02bct you want to work at Example Corp?",
    ];
    expect(labels.map((l) => labelReuse(l, "why-this-company", COMPANY))).toEqual([
      "new",
      "new",
      "new",
    ]);
  });
});

describe("isDisguisedLabel", () => {
  it.each([
    "Why would you n\u043et want to work at Example Corp?",
    "Why would you n\u200bot want to work at Example Corp?",
    "Why wouldn\u02bct you want to work at Example Corp?",
    "Why would you n\u03bft want to work at Example Corp?",
  ])("flags a Cyrillic, invisible, modifier or Greek character (%s)", (label) => {
    expect(isDisguisedLabel(label)).toBe(true);
  });

  it.each([
    "Why would you n\u0585t want to work at Example Corp?",
    "Why would you no\u0301t want to work at Example Corp?",
    "Why would you no\u034ft want to work at Example Corp?",
    "Why would you no\ufe0ft want to work at Example Corp?",
    "Why would you n\u2800ot want to work at Example Corp?",
    "Why would you n\u13a4t want to work at Example Corp?",
    "Why would you n\u3164ot want to work at Example Corp?",
  ])("flags another script's letter or a hidden mark or blank (%s, NS-273)", (label) => {
    expect(isDisguisedLabel(label)).toBe(true);
  });

  it("leaves accented Latin letters, dashes and symbols alone", () => {
    expect(
      [
        "Why do you want to work at Soci\u00e9t\u00e9 G\u00e9n\u00e9rale?",
        "Why do you want to work at Example Corp? \u2014 2\u20133 sentences, 100%",
      ].map(isDisguisedLabel),
    ).toEqual([false, false]);
  });

  it("leaves a plain label, curly apostrophe included, alone", () => {
    expect(
      ["Why do you want to work at Example Corp?", "Why wouldn\u2019t you join us?"].map(
        isDisguisedLabel,
      ),
    ).toEqual([false, false]);
  });
});

describe("labelReuse against other-script lookalikes and hidden marks (NS-273)", () => {
  it.each([
    "Why would you n\u0585t want to work at Example Corp?",
    "Why would you no\u0301t want to work at Example Corp?",
    "Why would you n\u2800ot want to work at Example Corp?",
    "Why would you n\u13a4t want to work at Example Corp?",
  ])("never counts reuse for %s", (label) => {
    expect(labelReuse(label, "why-this-company", COMPANY)).toBe("new");
  });

  it("still counts an accented company name's own wording as exact", () => {
    const company = "Soci\u00e9t\u00e9 G\u00e9n\u00e9rale";
    expect(labelReuse(`Why do you want to work at ${company}?`, "why-this-company", company)).toBe(
      "bank_exact",
    );
  });
});

describe("reuseStrength", () => {
  const canonical = { text: "Why are you interested in this role?", examples: [] };

  it("counts a match at the high-confidence floor as high confidence, and just below it as new", () => {
    expect([
      reuseStrength("Some label", { canonical, confidence: REUSE_HIGH_CONFIDENCE }, COMPANY),
      reuseStrength("Some label", { canonical, confidence: REUSE_HIGH_CONFIDENCE - 0.01 }, COMPANY),
    ]).toEqual(["bank_high_confidence", "new"]);
  });

  it("compares wording without case, spacing or a trailing question mark", () => {
    expect(isExactWording("  why are you interested   in this ROLE ", canonical, COMPANY)).toBe(
      true,
    );
  });
});

describe("weakerReuse", () => {
  it("keeps the weaker of two readings", () => {
    expect([
      weakerReuse("bank_exact", "bank_high_confidence"),
      weakerReuse("bank_high_confidence", "bank_exact"),
      weakerReuse("bank_exact", "new"),
      weakerReuse("bank_exact", "bank_exact"),
    ]).toEqual(["bank_high_confidence", "bank_high_confidence", "new", "bank_exact"]);
  });
});
