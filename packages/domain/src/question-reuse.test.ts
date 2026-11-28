import { describe, expect, it } from "vitest";
import { matchQuestion } from "./question-match.js";
import {
  isDisguisedLabel,
  isExactWording,
  isKnownWording,
  isReuseCompany,
  labelReuse,
  labelWords,
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
    "Why would you n\u20ddot want to work at Example Corp?",
    "Why would you n\u1d0ft want to work at Example Corp?",
    "Why would you n\u0275t want to work at Example Corp?",
    "Why wouldn\u0384t you want to work at Example Corp?",
    "Why wouldn\u1fbft you want to work at Example Corp?",
    "Why wouldn\u00b4t you want to work at Example Corp?",
    "Why would you n\ue000t want to work at Example Corp?",
  ])("flags another script's letter or a hidden mark or blank (%s, NS-273)", (label) => {
    expect(isDisguisedLabel(label)).toBe(true);
  });

  it("still flags every code point the NS-249 rule flagged (security review, NS-273)", () => {
    // The rule before NS-273, verbatim: widening it must never let one of these through.
    const before = /[\p{Cf}\u02B0-\u02FF\p{Script=Greek}\p{Script=Cyrillic}]/u;
    const missed: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
      if (before.test(c) && !isDisguisedLabel(`a${c}b`)) missed.push(cp);
    }
    expect(missed).toEqual([]);
  });

  it("leaves accented Latin letters, dashes and symbols alone", () => {
    expect(
      [
        "Why do you want to work at Soci\u00e9t\u00e9 G\u00e9n\u00e9rale?",
        "Why do you want to work at Example Corp? \u2014 2\u20133 sentences, 100%",
        "Why do you want to work at Vi\u1ec7t Nam Example Corp?",
      ].map(isDisguisedLabel),
    ).toEqual([false, false, false]);
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
    "Why wouldn\u0384t you want to work at Example Corp?",
    "Why wouldn\u1fbft you want to work at Example Corp?",
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

describe("labelReuse against negations behind lookalikes the disguise rule allows (NS-274)", () => {
  it.each([
    "Why wouldn`t you want to work at Example Corp?",
    "Why would you n0t want to work at Example Corp?",
    "Why would you n\u00f3t want to work at Example Corp?",
    "Why would you n\u00f8t want to work at Example Corp?",
    "Why would you n\ua74bt want to work at Example Corp?",
  ])("never counts reuse for %s", (label) => {
    expect(labelReuse(label, "why-this-company", COMPANY)).toBe("new");
  });
});

describe("reuseStrength", () => {
  const canonical = { text: "Why are you interested in this role?", examples: [] };

  // A label of known words only (NS-277), so this tests the confidence floor alone.
  const KNOWN = "Please tell us why you are interested in this role";

  it("counts a match at the high-confidence floor as high confidence, and just below it as new", () => {
    expect([
      reuseStrength(KNOWN, { canonical, confidence: REUSE_HIGH_CONFIDENCE }, COMPANY),
      reuseStrength(KNOWN, { canonical, confidence: REUSE_HIGH_CONFIDENCE - 0.01 }, COMPANY),
    ]).toEqual(["bank_high_confidence", "new"]);
  });

  it("counts a label with any unknown word as new, however high the confidence (NS-277)", () => {
    expect(reuseStrength("Some label", { canonical, confidence: 1 }, COMPANY)).toBe("new");
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

describe("labelReuse needs every word of the label to be known (NS-277, #429)", () => {
  it.each([
    "Why wouldn t you want to work at Example Corp?",
    "Why would you ne ver want to work at Example Corp?",
    "Why do you want to work at Example Corp and what is your salary?",
    "Why do you want to work at Example Corp\u0138",
  ])("counts %s as new", (label) => {
    expect(labelReuse(label, "why-this-company", COMPANY)).toBe("new");
  });

  it("still counts an honest rewording made of known words as high confidence", () => {
    const label = "Please tell us why you want to work at Example Corp";
    expect([matchQuestion(label).status, labelReuse(label, "why-this-company", COMPANY)]).toEqual([
      "matched",
      "bank_high_confidence",
    ]);
  });

  it("takes the company's words only when the name is plain and short", () => {
    const canonical = { text: "Why do you want to work at {company}?", examples: [] };
    expect([
      isKnownWording("Why do you want to work at Example Corp", canonical, COMPANY),
      isKnownWording("Why do you want to work at Acme Salary", canonical, "Acme? Salary"),
    ]).toEqual([true, false]);
  });

  it("reads a split word as its pieces and drops a possessive", () => {
    expect([labelWords("Wouldn t you"), labelWords("Example Corp's team")]).toEqual([
      ["wouldn", "t", "you"],
      ["example", "corp", "team"],
    ]);
  });
});

describe("a company name earns reuse only whole, short and where the label writes it (NS-278)", () => {
  const LONG = "Acme Your Salary Expectations";

  it("counts an ask split off a long company name as new", () => {
    expect(
      labelReuse(
        "Why do you want to work at Acme? Your salary expectations?",
        "why-this-company",
        LONG,
      ),
    ).toBe("new");
  });

  it("never counts the canonical wording as exact with a company name over three words", () => {
    expect(labelReuse(`Why do you want to work at ${LONG}?`, "why-this-company", LONG)).toBe("new");
  });

  it("gives the company's words no credit apart from the whole name", () => {
    const canonical = { text: "Why do you want to work at {company}?", examples: [] };
    expect([
      isKnownWording("Why do you want to work at Example Corp", canonical, COMPANY),
      isKnownWording("Why do you want to work at Corp", canonical, COMPANY),
      isKnownWording("Why do you want to work at Example Corp's team", canonical, COMPANY),
      isKnownWording("Example Corp", canonical, COMPANY),
    ]).toEqual([true, false, false, false]);
  });

  it("takes the name out only as often as a wording has the slot, so a repeated name is new", () => {
    expect(
      labelReuse(
        "Your Salary. Why do you want to work at Your Salary?",
        "why-this-company",
        "Your Salary",
      ),
    ).toBe("new");
  });

  it("gives no company credit to a canonical question with no company slot", () => {
    const canonical = { text: "Why are you interested in this role?", examples: [] };
    expect(
      isKnownWording("Why are you interested in this role at Example Corp", canonical, COMPANY),
    ).toBe(false);
  });

  it("still counts a plain short company name as exact and high confidence", () => {
    expect([
      labelReuse("Why do you want to work at Example Corp?", "why-this-company", COMPANY),
      labelReuse(
        "Please tell us why you want to work at Example Corp",
        "why-this-company",
        COMPANY,
      ),
    ]).toEqual(["bank_exact", "bank_high_confidence"]);
  });

  it("takes a company of at most three words and forty characters", () => {
    expect([
      isReuseCompany("Example Corp"),
      isReuseCompany("Bank of Example"),
      isReuseCompany(LONG),
      isReuseCompany("Examplelongcompanynamethatgoesonandonforever"),
      isReuseCompany(""),
    ]).toEqual([true, true, false, false, false]);
  });
});
