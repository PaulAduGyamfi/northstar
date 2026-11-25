import { describe, expect, it } from "vitest";
import type { EvidenceItem } from "./evidence.js";
import type { AnswerDraft } from "./schema.js";
import { validateAnswerDraft } from "./validate.js";

// Synthetic evidence (the repo is public): an invented story and atom.
const STORY: EvidenceItem = {
  id: "story-1",
  kind: "story",
  text: "Pushing back the card launch. Product wanted to launch card payments on a fixed date, but the fraud checks weren't finished. I wrote down what could go wrong and went through it with the product manager. We agreed to launch one week later.",
};
const ATOM: EvidenceItem = {
  id: "atom-1",
  kind: "atom",
  text: "Cut checkout errors by 30% at Example Payments by adding retries in Go.",
};
const EVIDENCE = [STORY, ATOM];

const good = (): AnswerDraft => ({
  sentences: [
    {
      text: "Product wanted to launch card payments on a fixed date, but the fraud checks weren't finished.",
      cites: [
        {
          id: "story-1",
          quote:
            "Product wanted to launch card payments on a fixed date, but the fraud checks weren't finished.",
        },
      ],
    },
    {
      text: "I wrote down what could go wrong, and we agreed to launch one week later.",
      cites: [
        { id: "story-1", quote: "I wrote down what could go wrong" },
        { id: "story-1", quote: "We agreed to launch one week later." },
      ],
    },
    {
      text: "At Example Payments I cut checkout errors by 30% with retries in Go.",
      cites: [{ id: "atom-1", quote: "Cut checkout errors by 30% at Example Payments" }],
    },
  ],
  followUps: [],
});

describe("validateAnswerDraft", () => {
  it("passes a draft whose every sentence cites given evidence with verbatim quotes", () => {
    expect(validateAnswerDraft(good(), EVIDENCE, null)).toEqual({ ok: true });
  });

  it("fails a sentence that cites nothing", () => {
    const draft = good();
    draft.sentences[1] = { text: "I always speak up.", cites: [] };
    expect(validateAnswerDraft(draft, EVIDENCE, null)).toEqual({
      ok: false,
      failures: [{ sentence: 1, problem: "cites nothing" }],
    });
  });

  it("fails a cite whose id isn't in the evidence it was given", () => {
    const draft = good();
    draft.sentences[0]?.cites.push({ id: "story-9", quote: "fixed date" });
    expect(validateAnswerDraft(draft, EVIDENCE, null)).toEqual({
      ok: false,
      failures: [{ sentence: 0, problem: "cite 1 names an id not in the evidence" }],
    });
  });

  it("fails a quote that isn't in the cited item, even if another item holds it", () => {
    const draft = good();
    draft.sentences[2] = {
      text: "I cut checkout errors.",
      cites: [{ id: "story-1", quote: "Cut checkout errors" }],
    };
    expect(validateAnswerDraft(draft, EVIDENCE, null)).toEqual({
      ok: false,
      failures: [{ sentence: 2, problem: "cite 0 quote is not in its item" }],
    });
  });

  it("fails a number that isn't in the sentence's own quotes", () => {
    const draft = good();
    draft.sentences[1] = {
      text: "We agreed to launch 2 weeks later.",
      cites: [{ id: "story-1", quote: "We agreed to launch one week later." }],
    };
    expect(validateAnswerDraft(draft, EVIDENCE, null)).toEqual({
      ok: false,
      failures: [{ sentence: 1, problem: "number at word 4 is not in its quotes" }],
    });
  });

  it("fails a capitalised name that isn't in the items the sentence cites", () => {
    const draft = good();
    draft.sentences[1] = {
      text: "I wrote down what could go wrong for Globex.",
      cites: [{ id: "story-1", quote: "I wrote down what could go wrong" }],
    };
    expect(validateAnswerDraft(draft, EVIDENCE, null)).toEqual({
      ok: false,
      failures: [{ sentence: 1, problem: "name at word 8 is not in its cited items" }],
    });
  });

  it("fails a first word that is a name the cited items don't hold", () => {
    const draft = good();
    draft.sentences[1] = {
      text: "Globex asked me to write down what could go wrong.",
      cites: [{ id: "story-1", quote: "I wrote down what could go wrong" }],
    };
    expect(validateAnswerDraft(draft, EVIDENCE, null)).toEqual({
      ok: false,
      failures: [{ sentence: 1, problem: "name at word 0 is not in its cited items" }],
    });
  });

  it("fails a number written in words that isn't in the sentence's quotes", () => {
    const draft = good();
    draft.sentences[1] = {
      text: "I worked with a team of twenty on it.",
      cites: [{ id: "story-1", quote: "I wrote down what could go wrong" }],
    };
    expect(validateAnswerDraft(draft, EVIDENCE, null)).toEqual({
      ok: false,
      failures: [{ sentence: 1, problem: "number at word 6 is not in its quotes" }],
    });
  });

  it("passes a number written in words when its quote holds it", () => {
    const draft = good();
    draft.sentences[1] = {
      text: "We agreed to launch one week later.",
      cites: [{ id: "story-1", quote: "We agreed to launch one week later." }],
    };
    expect(validateAnswerDraft(draft, EVIDENCE, null)).toEqual({ ok: true });
  });

  it("never puts the offending word in a failure", () => {
    const draft = good();
    draft.sentences[1] = {
      text: "Riley Sample and I shipped it in twelve days.",
      cites: [{ id: "story-1", quote: "We agreed to launch one week later." }],
    };
    const result = validateAnswerDraft(draft, EVIDENCE, null);
    expect(JSON.stringify(result)).not.toMatch(/Riley|Sample|twelve/);
  });

  it("fails a quote cut from inside a longer number", () => {
    const draft = good();
    draft.sentences[2] = {
      text: "I cut checkout errors by 0%.",
      cites: [{ id: "atom-1", quote: "0% at Example Payments" }],
    };
    expect(validateAnswerDraft(draft, EVIDENCE, null)).toEqual({
      ok: false,
      failures: [{ sentence: 2, problem: "cite 0 quote is not in its item" }],
    });
  });

  it("fails a quote cut from inside a decimal, so it can't back an invented figure", () => {
    const decimal: EvidenceItem = {
      id: "atom-2",
      kind: "atom",
      text: "Grew card revenue by 1.5 million dollars in one year.",
    };
    const draft = good();
    draft.sentences[2] = {
      text: "I grew card revenue by 5 million dollars.",
      cites: [{ id: "atom-2", quote: "5 million dollars in one year" }],
    };
    expect(validateAnswerDraft(draft, [...EVIDENCE, decimal], null)).toEqual({
      ok: false,
      failures: [{ sentence: 2, problem: "cite 0 quote is not in its item" }],
    });
  });

  it("fails a quote that stops inside a contraction", () => {
    const draft = good();
    draft.sentences[0] = {
      text: "Product wanted to launch card payments on a fixed date, but the fraud checks were finished.",
      cites: [{ id: "story-1", quote: "but the fraud checks weren" }],
    };
    expect(validateAnswerDraft(draft, EVIDENCE, null)).toEqual({
      ok: false,
      failures: [{ sentence: 0, problem: "cite 0 quote is not in its item" }],
    });
  });

  it("fails a quote of a single word", () => {
    const draft = good();
    draft.sentences[1] = { text: "We agreed.", cites: [{ id: "story-1", quote: "agreed" }] };
    expect(validateAnswerDraft(draft, EVIDENCE, null)).toEqual({
      ok: false,
      failures: [{ sentence: 1, problem: "cite 0 quote is shorter than 2 words" }],
    });
  });

  it("reads I've and I'm as Paul, not as names", () => {
    const draft = good();
    draft.sentences[1] = {
      text: "I've written down what could go wrong, and I'm glad we agreed to launch one week later.",
      cites: [
        { id: "story-1", quote: "I wrote down what could go wrong" },
        { id: "story-1", quote: "We agreed to launch one week later." },
      ],
    };
    expect(validateAnswerDraft(draft, EVIDENCE, null)).toEqual({ ok: true });
  });

  it("accepts a first word that is an opener or a lower-case word of the cited text", () => {
    const draft = good();
    draft.sentences[0] = {
      text: "However, the fraud checks weren't finished.",
      cites: [{ id: "story-1", quote: "the fraud checks weren't finished." }],
    };
    draft.sentences[1] = {
      text: "Fraud checks mattered, so we agreed to launch one week later.",
      cites: [{ id: "story-1", quote: "We agreed to launch one week later." }],
    };
    expect(validateAnswerDraft(draft, EVIDENCE, null)).toEqual({ ok: true });
  });

  it("fails an answer longer than the form's limit, never cutting it", () => {
    const limit = 50;
    expect(validateAnswerDraft(good(), EVIDENCE, limit)).toEqual({
      ok: false,
      failures: [{ sentence: null, problem: `longer than the limit of ${limit} characters` }],
    });
  });

  it("matches quotes across curly quotes, dashes and line breaks", () => {
    const draft = good();
    draft.sentences[0] = {
      text: "The fraud checks weren’t finished.",
      cites: [{ id: "story-1", quote: "the fraud checks weren’t\nfinished." }],
    };
    expect(validateAnswerDraft(draft, EVIDENCE, null)).toEqual({ ok: true });
  });
});
