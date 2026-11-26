import { describe, expect, it } from "vitest";
import { atomEvidence, type EvidenceItem, selectEvidence, storyEvidence } from "./evidence.js";

// Synthetic stories and atoms (the repo is public).
const conflict = storyEvidence({
  id: "s-conflict",
  title: "Pushing back the card launch",
  situation: "Product wanted to launch on a fixed date, but the fraud checks weren't finished",
  task: "I owned the payment flow",
  action: "I went through the risks with the product manager, who disagreed at first",
  result: "We agreed to launch one week later",
});
const deadlines = storyEvidence({
  id: "s-deadline",
  title: "Shipping the export before the deadline",
  situation: "A customer needed the export by Friday",
  task: "I had to ship it",
  action: "I cut the scope to CSV only",
  result: "We shipped on Thursday",
});
const atomDisagreed: EvidenceItem = atomEvidence({
  id: "a-1",
  sourceQuote: "Disagreed with the launch plan and proposed a staged rollout.",
});
const atomOther = atomEvidence({ id: "a-2", sourceQuote: "Wrote the on-call runbook." });
const ALL = [atomOther, atomDisagreed, deadlines, conflict];

describe("storyEvidence", () => {
  it("joins the title and the four parts, each ending as a sentence", () => {
    expect(deadlines.text).toBe(
      "Shipping the export before the deadline. A customer needed the export by Friday. I had to ship it. I cut the scope to CSV only. We shipped on Thursday.",
    );
  });

  it("checks quotes and names against the four parts only, without the title", () => {
    expect(deadlines.checkText).toBe(
      "A customer needed the export by Friday. I had to ship it. I cut the scope to CSV only. We shipped on Thursday.",
    );
  });

  it("gives an atom no separate text to check", () => {
    expect(atomOther.checkText).toBeUndefined();
  });
});

describe("selectEvidence", () => {
  it("ranks by shared question words and drops items that share none", () => {
    const picked = selectEvidence("Tell us about a time you missed a deadline.", ALL);
    expect(picked.map((e) => e.id)).toEqual(["s-deadline"]);
  });

  it("puts a story before an atom with the same score", () => {
    const picked = selectEvidence("When did you disagree about a launch?", ALL);
    // Both share only "launch" ("disagree" is not "disagreed"), so the story goes first.
    expect(picked.map((e) => e.id)).toEqual(["s-conflict", "a-1"]);
  });

  it("returns nothing for a question that shares no word with any item", () => {
    expect(selectEvidence("What is your favourite colour?", ALL)).toEqual([]);
  });

  it("keeps at most the limit", () => {
    expect(selectEvidence("launch deadline export runbook", ALL, 2)).toHaveLength(2);
  });

  it("gives the same order whatever order the items come in", () => {
    const q = "Tell us about a launch you disagreed with.";
    expect(selectEvidence(q, [...ALL].reverse())).toEqual(selectEvidence(q, ALL));
  });
});
