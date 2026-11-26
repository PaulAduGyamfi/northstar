import { describe, expect, it } from "vitest";
import type { EvidenceItem } from "../answer/evidence.js";
import type { ReplyDraft } from "./schema.js";
import { validateReplyDraft } from "./validate.js";

// Synthetic email and evidence only (the repo is public).
const EMAIL =
  "Hi Paul, I'm Dana, a recruiter at Initech. Could you tell me about your payments work? " +
  "We'd love to set up a call.";
const EVIDENCE: EvidenceItem[] = [
  {
    id: "atom-1",
    kind: "atom",
    text: "Built the card payments flow at Globex for 12 merchants.",
  },
];

type Sentence = ReplyDraft["sentences"][number];
const frame = (text: string): Sentence => ({ text, cites: [] });
const claim: Sentence = {
  text: "I built the card payments flow at Globex for 12 merchants.",
  cites: [{ id: "atom-1", quote: "Built the card payments flow at Globex for 12 merchants." }],
};
const draft = (...sentences: Sentence[]): ReplyDraft => ({ sentences, followUps: [] });
const check = (d: ReplyDraft) => validateReplyDraft(d, EVIDENCE, EMAIL);

describe("validateReplyDraft", () => {
  it("passes cited claims between a plain greeting and a plain next step", () => {
    expect(
      check(
        draft(
          frame("Hi Dana, thanks for reaching out about the role at Initech."),
          claim,
          frame("I'll send my availability shortly."),
        ),
      ),
    ).toEqual({ ok: true });
  });

  it("passes a reply of framing alone, such as accepting an assessment invite", () => {
    expect(
      check(draft(frame("Thanks, Dana."), frame("I'm happy to take the assessment."))),
    ).toEqual({ ok: true });
  });

  it("fails a claim whose number isn't in its quotes, naming the reply's own sentence", () => {
    const inflated: Sentence = {
      ...claim,
      text: "I built the card payments flow for 40 merchants.",
    };
    expect(check(draft(frame("Hi Dana,"), inflated))).toEqual({
      ok: false,
      failures: [{ sentence: 1, problem: "number at word 7 is not in its quotes" }],
    });
  });

  it("fails a claim that names an employer its cited item doesn't", () => {
    const moved: Sentence = { ...claim, text: "I built the card payments flow at Hooli." };
    expect(check(draft(moved))).toEqual({
      ok: false,
      failures: [{ sentence: 0, problem: "name at word 7 is not in its cited items" }],
    });
  });

  it("fails framing that states a number, in digits or in words", () => {
    expect(check(draft(frame("I have 8 years of payments work.")))).toEqual({
      ok: false,
      failures: [{ sentence: 0, problem: "framing has a number at word 2" }],
    });
    expect(check(draft(frame("I have ten years of payments work.")))).toEqual({
      ok: false,
      failures: [{ sentence: 0, problem: "framing has a number at word 2" }],
    });
  });

  it("fails framing that proposes a time", () => {
    expect(check(draft(frame("Could we talk tomorrow afternoon?")))).toEqual({
      ok: false,
      failures: [
        { sentence: 0, problem: "framing has a time at word 3" },
        { sentence: 0, problem: "framing has a time at word 4" },
      ],
    });
  });

  it("fails framing that names something the email doesn't", () => {
    expect(check(draft(frame("Thanks, Dana, I enjoyed my time at Globex.")))).toEqual({
      ok: false,
      failures: [{ sentence: 0, problem: "framing has a name at word 7 that isn't in the email" }],
    });
  });

  it("fails a fourth framing sentence", () => {
    const greeting = frame("Thanks, Dana.");
    expect(check(draft(greeting, greeting, greeting, greeting))).toEqual({
      ok: false,
      failures: [{ sentence: null, problem: "more than 3 framing sentences" }],
    });
  });

  it("fails framing over 25 words", () => {
    const long = frame(`Thanks for reaching out${" and I appreciate it".repeat(6)}.`);
    expect(check(draft(long))).toEqual({
      ok: false,
      failures: [{ sentence: 0, problem: "framing is longer than 25 words" }],
    });
  });

  it("never puts the draft's or the email's text in a failure", () => {
    const result = check(draft(frame("Thanks, Dana, I enjoyed Globex on Monday at 9.")));
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result);
    for (const word of ["Dana", "Globex", "Monday", "enjoyed"]) expect(text).not.toContain(word);
  });
});
