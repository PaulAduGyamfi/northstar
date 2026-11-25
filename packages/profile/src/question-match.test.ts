import { describe, expect, it } from "vitest";
import { CANONICAL_QUESTIONS } from "./question-canon.js";
import { classifyQuestion, matchQuestion, questionConcepts } from "./question-match.js";

// The canonical id a question maps to, or "new" when it maps to none.
function idOf(question: string): string {
  const match = matchQuestion(question);
  return match.status === "matched" ? match.canonical.id : "new";
}

describe("the question catalog", () => {
  it("has unique ids", () => {
    const ids = CANONICAL_QUESTIONS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives a settings field to every factual question and to no other kind", () => {
    for (const q of CANONICAL_QUESTIONS) {
      expect({ id: q.id, hasField: q.factualField !== null }).toEqual({
        id: q.id,
        hasField: q.kind === "factual",
      });
    }
  });

  it("has at least two wordings per question, counting the canonical text", () => {
    for (const q of CANONICAL_QUESTIONS) {
      expect({ id: q.id, enough: q.examples.length >= 1 }).toEqual({ id: q.id, enough: true });
    }
  });

  it("matches every wording to its own question with confidence 1 and no ambiguity", () => {
    for (const q of CANONICAL_QUESTIONS) {
      for (const wording of [q.text, ...q.examples]) {
        const match = matchQuestion(wording);
        expect({ wording, match }).toEqual({
          wording,
          match: { status: "matched", canonical: q, confidence: 1 },
        });
      }
    }
  });
});

describe("questionConcepts", () => {
  it("maps words with the same intent to one concept and drops filler words", () => {
    expect([...questionConcepts("What excites you about this role?")].sort()).toEqual([
      "interest",
      "role",
    ]);
  });

  it("turns a capitalised name inside the sentence into the name slot", () => {
    expect([...questionConcepts("How many years have you used PostgreSQL?")].sort()).toEqual([
      "used",
      "year",
      "{name}",
    ]);
  });

  it("does not treat the first word of a sentence as a name", () => {
    expect([...questionConcepts("Relocation: are you open to it?")].sort()).toEqual([
      "open",
      "relocate",
    ]);
  });

  it("skips name detection when the whole question is in capitals", () => {
    expect([...questionConcepts("WHY ARE YOU INTERESTED IN THIS POSITION?")].sort()).toEqual([
      "interest",
      "role",
    ]);
  });

  it("finds no concepts in an empty question", () => {
    expect(questionConcepts("  ?! ").size).toBe(0);
  });
});

describe("matchQuestion", () => {
  it("maps two wordings of 'why this role' to the same canonical question (ANS-002)", () => {
    expect(idOf("What excites you about this role?")).toBe("why-this-role");
    expect(idOf("Why are you interested in this position?")).toBe("why-this-role");
  });

  it("maps wordings that aren't in the catalog to the right question", () => {
    const cases: Array<[string, string]> = [
      ["Are you legally eligible to work in Canada?", "work-authorization"],
      ["Do you now or will you in the future need visa sponsorship?", "sponsorship"],
      [
        "How many years of professional experience do you have with Kubernetes?",
        "years-experience",
      ],
      ["What is the earliest date you could start?", "start-date"],
      ["What are your compensation expectations for this role?", "salary-expectation"],
      ["Tell me about a time you disagreed with a teammate.", "conflict"],
      ["Describe a time you made a mistake at work.", "failure"],
      ["Why do you want to join Example Corp?", "why-this-company"],
      ["Please tell us a bit about yourself.", "about-yourself"],
    ];
    for (const [question, id] of cases)
      expect({ question, id: idOf(question) }).toEqual({ question, id });
  });

  it("reports the confidence of a near match", () => {
    expect(matchQuestion("Why are you interested in working here at Example?")).toEqual({
      status: "matched",
      canonical: CANONICAL_QUESTIONS.find((q) => q.id === "why-this-company"),
      confidence: 0.86,
    });
  });

  it("needs a stricter score to map to a factual question", () => {
    // 0.67 would pass MATCH_THRESHOLD, but a factual answer is filled in without drafting.
    expect(matchQuestion("Have you applied to Northwind before?")).toEqual({
      status: "new",
      reason: "below_threshold",
      confidence: 0.67,
      nearest: "previously-employed",
    });
  });

  it("treats a negated factual question as new, since the setting answers the other polarity", () => {
    expect(matchQuestion("Can you work in the US without sponsorship?")).toEqual({
      status: "new",
      reason: "negated",
      confidence: 0.75,
      nearest: "sponsorship",
    });
  });

  it("does not read 'tell us' as naming the company", () => {
    expect(idOf("Tell us about a project you're proud of.")).toBe("accomplishment");
  });

  it("does not map a question that only mentions 'us' to 'why this company'", () => {
    expect(idOf("What questions do you have for us?")).toBe("new");
  });

  it("reads 'the US' as a country, not as the company", () => {
    expect(questionConcepts("Can you work in the US without sponsorship?").has("company")).toBe(
      false,
    );
  });

  it("treats an unrelated question as new, below the threshold", () => {
    const match = matchQuestion("What is your favorite sandwich?");
    expect(match.status === "new" ? match.reason : match.status).toBe("below_threshold");
  });

  it("treats an empty question as new with no nearest question", () => {
    expect(matchQuestion("   ")).toEqual({
      status: "new",
      reason: "empty",
      confidence: 0,
      nearest: null,
    });
  });

  it("ignores case, curly quotes and punctuation", () => {
    expect(matchQuestion("what’s your SALARY expectation...")).toEqual(
      matchQuestion("What's your salary expectation?"),
    );
  });
});

describe("classifyQuestion", () => {
  it("classifies a factual question with its settings field (ANS-001)", () => {
    expect(classifyQuestion("Will you require visa sponsorship?")).toMatchObject({
      kind: "factual",
      factualField: "needs_sponsorship",
    });
  });

  it("classifies a reusable narrative question with no settings field", () => {
    expect(classifyQuestion("Describe a challenging project you worked on.")).toMatchObject({
      kind: "reusable_narrative",
      factualField: null,
    });
  });

  it("classifies 'why us' as company-specific", () => {
    expect(classifyQuestion("Why us?")).toMatchObject({
      kind: "company_specific",
      factualField: null,
    });
  });

  it("classifies a new question that names the company as company-specific", () => {
    expect(classifyQuestion("What do you think of Example's new pricing page?")).toMatchObject({
      kind: "company_specific",
      factualField: null,
      match: { status: "new" },
    });
  });

  it("classifies any other new question as reusable narrative, never factual", () => {
    expect(classifyQuestion("What is your favorite sandwich?")).toMatchObject({
      kind: "reusable_narrative",
      factualField: null,
      match: { status: "new", reason: "below_threshold" },
    });
  });
});
