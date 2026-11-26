import { describe, expect, it } from "vitest";
import type { EvidenceItem } from "../answer/evidence.js";
import type { ReplyDraft } from "./schema.js";
import { framingSentences, greetingName, validateReplyDraft } from "./validate.js";

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
const QUOTE = "Built the card payments flow at Globex for 12 merchants.";
const claim: Sentence = {
  text: "I built the card payments flow at Globex for 12 merchants.",
  cites: [{ id: "atom-1", quote: QUOTE }],
};
// The cited claim with words added at its end.
const claimPlus = (extra: string): Sentence => ({
  ...claim,
  text: `I built the card payments flow at Globex for 12 merchants ${extra}`,
});
const draft = (...sentences: Sentence[]): ReplyDraft => ({ sentences, followUps: [] });
const check = (d: ReplyDraft, sender: string | null = SENDER) =>
  validateReplyDraft(d, EVIDENCE, sender);
const NOT_ALLOWED = "framing is not one of the allowed sentences";

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
    ).toEqual({ ok: true });
  });

  it("fails framing that adds one word to an allowed sentence", () => {
    expect(check(draft(frame("Hi Dana, thanks for reaching out from Initech.")))).toEqual({
      ok: false,
      failures: [{ sentence: 0, problem: NOT_ALLOWED }],
    });
  });

  it("fails framing built only from allowed words that still says yes", () => {
    expect(["I'm in.", "I will.", "I'd be glad to."].map((t) => check(draft(frame(t))))).toEqual([
      { ok: false, failures: [{ sentence: 0, problem: NOT_ALLOWED }] },
      { ok: false, failures: [{ sentence: 0, problem: NOT_ALLOWED }] },
      { ok: false, failures: [{ sentence: 0, problem: NOT_ALLOWED }] },
    ]);
  });

  it("fails a greeting with a name when the sender's name can't be used", () => {
    expect(check(draft(frame("Hi Yes,")), "Yes Recruiting")).toEqual({
      ok: false,
      failures: [{ sentence: 0, problem: NOT_ALLOWED }],
    });
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

  it("fails a claim that adds a commitment word, in any form or joined", () => {
    expect(
      ["and accepted.", "and will re-locate.", "and got paid."].map((t) =>
        check(draft(claimPlus(t))),
      ),
    ).toEqual([
      {
        ok: false,
        failures: [{ sentence: 0, problem: "commitment word at word 12 is not in its quotes" }],
      },
      {
        ok: false,
        failures: [{ sentence: 0, problem: "commitment word at word 13 is not in its quotes" }],
      },
      {
        ok: false,
        failures: [{ sentence: 0, problem: "commitment word at word 13 is not in its quotes" }],
      },
    ]);
  });

  it("fails a claim that adds a time", () => {
    expect(check(draft(claimPlus("and can talk tomorrow.")))).toEqual({
      ok: false,
      failures: [{ sentence: 0, problem: "time at word 14 is not in its quotes" }],
    });
  });

  it("fails a claim that adds a link", () => {
    expect(check(draft(claimPlus("at https://evil.example/x")))).toEqual({
      ok: false,
      failures: [{ sentence: 0, problem: "word 12 is a link or address that isn't in its quotes" }],
    });
  });

  it("fails a claim that adds a symbol", () => {
    expect(check(draft(claimPlus("✅")))).toEqual({
      ok: false,
      failures: [{ sentence: 0, problem: "word 11 has a symbol that isn't in its quotes" }],
    });
  });

  it("fails a claim that hides a commitment behind lookalike letters", () => {
    // Cyrillic "а" in "accept", Latin alpha "ɑ" in "accept", dotless "ı" in "sign".
    const words = ["\u0430ccept", "\u0251ccept", "s\u0131gn"];
    expect(words.map((w) => check(draft(claimPlus(`and I ${w}.`))))).toEqual(
      words.map(() => ({
        ok: false,
        failures: [
          { sentence: 0, problem: "word 13 has unusual letters that aren't in its quotes" },
        ],
      })),
    );
  });

  it("fails a claim that adds a commitment word behind a prefix", () => {
    const words = ["countersign", "rejoin", "prepay"];
    expect(words.map((w) => check(draft(claimPlus(`and ${w}.`))))).toEqual(
      words.map(() => ({
        ok: false,
        failures: [{ sentence: 0, problem: "commitment word at word 12 is not in its quotes" }],
      })),
    );
  });

  it("fails a claim that adds a short day name", () => {
    expect(check(draft(claimPlus("and can talk fri.")))).toEqual({
      ok: false,
      failures: [{ sentence: 0, problem: "time at word 14 is not in its quotes" }],
    });
  });

  it("fails a claim that adds a bare domain", () => {
    expect(check(draft(claimPlus("see calendly.com/someone")))).toEqual({
      ok: false,
      failures: [{ sentence: 0, problem: "word 12 is a link or address that isn't in its quotes" }],
    });
  });

  it("fails a sentence whose word is split by a hair space", () => {
    expect(check(draft(claimPlus("and I ac\u200acept.")))).toEqual({
      ok: false,
      failures: [{ sentence: 0, problem: "the sentence has a hidden or unusual space" }],
    });
  });

  it("fails a sentence with an invisible character", () => {
    expect(check(draft(claimPlus("and I acc​ept.")))).toEqual({
      ok: false,
      failures: [
        { sentence: 0, problem: "commitment word at word 13 is not in its quotes" },
        { sentence: 0, problem: "the sentence has a hidden or unusual space" },
      ],
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
    const thanks = frame("Thanks again.");
    expect(check(draft(thanks, thanks, thanks, thanks))).toEqual({
      ok: false,
      failures: [{ sentence: null, problem: "more than 3 framing sentences" }],
    });
  });

  it("never puts the draft's text in a failure", () => {
    const result = check(
      draft(frame("Thanks, Dana, I enjoyed Globex on Monday."), claimPlus("tomorrow")),
    );
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result);
    for (const word of ["Globex", "Monday", "enjoyed", "tomorrow"])
      expect(text).not.toContain(word);
  });
});

describe("greetingName", () => {
  it("keeps a plain capitalised first name", () => {
    expect(["Dana Reyes", "Dana <dana@example.com>"].map(greetingName)).toEqual(["Dana", "Dana"]);
  });

  it("drops a name that answers, commits or sets a time, since the sender chooses it", () => {
    expect(
      ["Yes Recruiting", "Accepted Talent", "Sure", "Ok", "Monday", "Tomorrow"].map(greetingName),
    ).toEqual([null, null, null, null, null, null]);
  });

  it("drops a name with a lookalike letter", () => {
    // Cyrillic "е" in "Yes".
    expect(greetingName("Y\u0435s Team")).toBeNull();
  });

  it("drops anything but one word of letters", () => {
    expect(["dana", "Yes-I-Accept", "O'Brien", "A", "", null].map(greetingName)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });
});

describe("framingSentences", () => {
  it("offers nameless greetings only, when there is no name", () => {
    const allowed = framingSentences(null);
    expect([
      allowed.has("Hi,"),
      allowed.has("Hi {name},"),
      allowed.has("Hi , thanks again."),
    ]).toEqual([true, false, false]);
  });
});
