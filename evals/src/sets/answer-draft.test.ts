import { describe, expect, it } from "vitest";
import { gradeAnswerDraft, withoutTitle } from "./answer-draft.js";

// The answer-draft grader (NS-265): a story's title is no evidence, as in the app. Invented
// stories only.

const input = {
  question: "Tell us about a time you disagreed with a decision at work.",
  limit: null,
  voiceGuide: "",
  evidence: [
    {
      id: "s-launch",
      kind: "story",
      text: "Pushing back the card payments launch. Product wanted to launch card payments on a fixed date, but the fraud checks weren't finished. We agreed to launch one week later.",
    },
  ],
};
const expected = { citesAnyOf: ["s-launch"], followUps: false };

const draft = (quote: string) => ({
  sentences: [
    {
      text: "We agreed to launch one week later.",
      cites: [{ id: "s-launch", quote }],
    },
  ],
  followUps: [],
});

describe("withoutTitle", () => {
  it("drops a story's first sentence, its title", () => {
    expect(withoutTitle("Making retries safe. Checkout calls failed. I added retries.")).toBe(
      "Checkout calls failed. I added retries.",
    );
  });

  it("leaves nothing to quote when there is no second sentence", () => {
    expect(withoutTitle("Only a title.")).toBe("");
  });
});

describe("gradeAnswerDraft", () => {
  it("passes a draft that quotes the story's parts", () => {
    expect(gradeAnswerDraft(draft("We agreed to launch one week later."), expected, input)).toBe(
      true,
    );
  });

  it("fails a draft that quotes the story's title, as the app's check does", () => {
    expect(gradeAnswerDraft(draft("Pushing back the card payments launch."), expected, input)).toBe(
      false,
    );
  });
});
