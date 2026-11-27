import { describe, expect, it } from "vitest";
import { matchQuestion } from "./question-match.js";
import {
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
