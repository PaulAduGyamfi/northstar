import { describe, expect, it } from "vitest";
import { gradeReplyDraft } from "./reply-draft.js";

// Synthetic email and evidence only.
const input = {
  email: "Hi, I'm Dana at Initech. Could you tell me about your payments work?",
  sender: "Dana",
  need: "reply",
  voiceGuide: "",
  evidence: [{ id: "atom-1", kind: "atom", text: "Built the card payments flow at Globex." }],
};
const claim = {
  text: "I built the card payments flow at Globex.",
  cites: [{ id: "atom-1", quote: "Built the card payments flow at Globex." }],
};
const greeting = { text: "Hi Dana, thanks for reaching out.", cites: [] };

describe("gradeReplyDraft", () => {
  it("passes a checked reply that cites the expected item", () => {
    const output = { sentences: [greeting, claim], followUps: [] };
    expect(gradeReplyDraft(output, { citesAnyOf: ["atom-1"], followUps: false }, input)).toBe(true);
  });

  it("fails a reply that cites something when no claim was expected", () => {
    const output = { sentences: [greeting, claim], followUps: [] };
    expect(gradeReplyDraft(output, { citesAnyOf: [], followUps: false }, input)).toBe(false);
  });

  it("fails a reply that the check refuses, such as framing with a day", () => {
    const output = { sentences: [{ text: "Could we talk on Monday?", cites: [] }], followUps: [] };
    expect(gradeReplyDraft(output, { citesAnyOf: [], followUps: false }, input)).toBe(false);
  });

  it("fails a reply holding a word the case forbids", () => {
    const output = {
      sentences: [greeting, { text: "I'd be glad to talk.", cites: [] }],
      followUps: [],
    };
    const expected = { citesAnyOf: [], followUps: false, absent: ["glad"] };
    expect(gradeReplyDraft(output, expected, input)).toBe(false);
  });
});
