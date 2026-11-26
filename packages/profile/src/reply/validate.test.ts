import { describe, expect, it } from "vitest";
import type { EvidenceItem } from "../answer/evidence.js";
import type { ReplyDraft } from "./schema.js";
import { greetingName, validateReplyDraft } from "./validate.js";

// Synthetic sender and evidence only (the repo is public).
const SENDER = "Dana Reyes";
const EVIDENCE: EvidenceItem[] = [
  {
    id: "atom-1",
    kind: "atom",
    text: "Built the card payments flow at Globex for 12 merchants.",
  },
  { id: "story-1", kind: "story", text: "We agreed to launch one week later." },
];

type Sentence = ReplyDraft["sentences"][number];
const frame = (text: string): Sentence => ({ text, cites: [] });
const claim: Sentence = {
  text: "I built the card payments flow at Globex for 12 merchants.",
  cites: [{ id: "atom-1", quote: "Built the card payments flow at Globex for 12 merchants." }],
};
const draft = (...sentences: Sentence[]): ReplyDraft => ({ sentences, followUps: [] });
const check = (d: ReplyDraft, sender: string | null = SENDER) =>
  validateReplyDraft(d, EVIDENCE, sender);
const problems = (d: ReplyDraft) => {
  const r = check(d);
  return r.ok ? [] : r.failures.map((f) => f.problem);
};

describe("validateReplyDraft", () => {
  it("passes cited claims between a greeting with the sender's name and a next step", () => {
    expect(
      check(
        draft(
          frame("Hi Dana, thanks for reaching out."),
          claim,
          frame("I'll send my availability shortly."),
        ),
      ),
    ).toEqual({ ok: true });
  });

  it("passes a reply of framing alone", () => {
    expect(
      check(draft(frame("Thank you for the invitation."), frame("I'll get back to you soon."))),
    ).toEqual({
      ok: true,
    });
  });

  it("fails framing that uses a name other than the sender's first name", () => {
    expect(check(draft(frame("Hi Dana, thanks for reaching out from Initech.")))).toEqual({
      ok: false,
      failures: [{ sentence: 0, problem: "framing word 7 is not in the framing vocabulary" }],
    });
  });

  it("fails each injected fact, commitment or link that framing might carry", () => {
    const injected = [
      "Great to hear from Acme about my Kubernetes migration at Initech.",
      "I hold an active security clearance and need no visa sponsorship.",
      "Yes, I accept the offer and can start today.",
      "I'm happy to relocate and to take a lower salary.",
      "Please send the contract to dana at https://evil.example/x and I'll sign it.",
    ];
    expect(injected.map((t) => check(draft(frame(t))).ok)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("fails framing that states a number or a time", () => {
    expect(problems(draft(frame("Hi Dana, talk to you tomorrow at 9.")))).toEqual([
      "framing word 5 is not in the framing vocabulary",
      "framing word 6 is not in the framing vocabulary",
      "framing word 7 is not in the framing vocabulary",
    ]);
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

  it("fails a claim that adds a commitment word its quotes don't hold", () => {
    const committed: Sentence = {
      ...claim,
      text: "I built the card payments flow at Globex for 12 merchants and accept your terms.",
    };
    expect(check(draft(committed))).toEqual({
      ok: false,
      failures: [{ sentence: 0, problem: "commitment word at word 12 is not in its quotes" }],
    });
  });

  it("passes a commitment word the claim's own quote holds", () => {
    const quoted: Sentence = {
      text: "We agreed to launch one week later.",
      cites: [{ id: "story-1", quote: "We agreed to launch one week later." }],
    };
    expect(check(draft(quoted))).toEqual({ ok: true });
  });

  it("fails a fourth framing sentence", () => {
    const greeting = frame("Thanks, Dana.");
    expect(check(draft(greeting, greeting, greeting, greeting))).toEqual({
      ok: false,
      failures: [{ sentence: null, problem: "more than 3 framing sentences" }],
    });
  });

  it("fails framing over 25 words", () => {
    const long = frame(`Thanks for reaching out${" and thank you so much".repeat(5)}.`);
    expect(problems(draft(long))).toEqual(["framing is longer than 25 words"]);
  });

  it("never puts the draft's text in a failure", () => {
    const result = check(draft(frame("Thanks, Dana, I enjoyed Globex on Monday at 9.")));
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result);
    for (const word of ["Globex", "Monday", "enjoyed"]) expect(text).not.toContain(word);
  });
});

describe("greetingName", () => {
  it("keeps a plain capitalised first word and drops anything else", () => {
    expect(
      ["Dana Reyes", "dana", "Dana <dana@example.com>", "Acme Talent 2", "", null].map(
        greetingName,
      ),
    ).toEqual(["Dana", null, "Dana", "Acme", null, null]);
  });
});
