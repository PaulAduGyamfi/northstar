import { describe, expect, it } from "vitest";
import { avoidedPhrases, deletedPhrases, findAvoided } from "./edits.js";
import { measureVoice, renderVoiceGuide } from "./measure.js";

// Synthetic writing samples (the repo is public): invented, short, in one person's habits.
const SAMPLES = [
  "Quick note on the release. I think we're in good shape. Happy to walk through it.",
  "I shipped the fix last night. Happy to walk through it if that helps. We're close.",
  "Thanks for the review! I'll update the docs today. Happy to walk through the change.",
  "I didn't expect the load test to pass. It did. We're ready for Monday.",
  "Short update: the migration is done. I think the rollback plan held up well.",
];

describe("measureVoice", () => {
  it("measures sentence length, contractions, I and we, and exclamation marks", () => {
    const result = measureVoice(SAMPLES);
    if (!result.ok) throw new Error(result.problem);
    const { phrases: _phrases, ...numbers } = result.profile;
    expect(numbers).toEqual({
      samples: 5,
      words: 75,
      // 14 sentences; the middle two have 5 and 6 words.
      sentenceWords: 6,
      // we're ×3, I'll, didn't.
      contractionsPer100: 6.7,
      // I ×4, I'll.
      iPer100: 6.7,
      // we're ×3.
      wePer100: 4,
      exclamationShare: 0.07,
    });
  });

  it("keeps phrases used in at least 3 samples, longest form only", () => {
    const result = measureVoice(SAMPLES);
    if (!result.ok) throw new Error(result.problem);
    expect(result.profile.phrases).toEqual(["happy to walk through"]);
  });

  it("never keeps a phrase made only of common words", () => {
    const common = ["it is the one.", "it is the two.", "it is the three.", "a.", "b."];
    const result = measureVoice(common);
    if (!result.ok) throw new Error(result.problem);
    expect(result.profile.phrases).toEqual([]);
  });

  it("refuses fewer than 5 or more than 10 samples (ANS-007)", () => {
    expect(measureVoice(SAMPLES.slice(0, 4))).toEqual({
      ok: false,
      problem: "need 5 to 10 writing samples, got 4",
    });
    expect(measureVoice([...SAMPLES, ...SAMPLES, "One more."]).ok).toBe(false);
  });

  it("refuses a sample longer than 5,000 words, so measuring stays quick", () => {
    const long = "word ".repeat(5001);
    expect(measureVoice([...SAMPLES.slice(0, 4), long])).toEqual({
      ok: false,
      problem: "sample 5 is longer than 5000 words",
    });
  });

  it("refuses a sample with no words", () => {
    expect(measureVoice([...SAMPLES.slice(0, 4), "   "])).toEqual({
      ok: false,
      problem: "sample 5 has no words",
    });
  });
});

describe("renderVoiceGuide", () => {
  it("writes short plain lines", () => {
    const result = measureVoice(SAMPLES);
    if (!result.ok) throw new Error(result.problem);
    expect(renderVoiceGuide(result.profile)).toBe(
      [
        "Sentences: about 6 words.",
        "Contractions: often (6.7 per 100 words).",
        'Says "I" 6.7 and "we" 4 times per 100 words.',
        "Exclamation marks: rarely.",
        'Phrases they use: "happy to walk through".',
      ].join("\n"),
    );
  });
});

describe("deletedPhrases", () => {
  it("returns each run of words removed from the draft, trimmed of common words", () => {
    const draft = "I want to leverage our synergies and ship the fix this week.";
    const approved = "I want to ship the fix this week.";
    expect(deletedPhrases(draft, approved)).toEqual(["leverage our synergies"]);
  });

  it("ignores a removed run made only of common words", () => {
    expect(deletedPhrases("I think that it is done.", "I think it is done.")).toEqual([]);
  });

  it("measures the four-word limit after trimming common words", () => {
    const draft = "I want to leverage our synergies and ship it.";
    expect(deletedPhrases(draft, "I want ship it.")).toEqual(["leverage our synergies"]);
  });

  it("reads look-alike and hidden characters as plain letters", () => {
    // A full-width "ｌ", a soft hyphen inside the word, and a modifier-letter apostrophe.
    expect(findAvoided("We ｌever\u00adage it, don\u02BCt we?", ["leverage", "don't"])).toEqual([
      0, 1,
    ]);
  });

  it("ignores a rewrite longer than four words", () => {
    const draft = "We dramatically and comprehensively overhauled the whole legacy pipeline today.";
    expect(deletedPhrases(draft, "We rebuilt it today.")).toEqual([]);
  });
});

describe("avoidedPhrases (ANS-008)", () => {
  const edit = (draft: string, approved: string) => ({ draft, approved });
  const cut = (n: number) =>
    edit(`Draft ${n}: I can leverage our tooling to help.`, `Draft ${n}: I can help.`);

  it("avoids a phrase Paul deleted in 3 drafts", () => {
    expect(avoidedPhrases([cut(1), cut(2), cut(3)])).toEqual(["leverage our tooling"]);
  });

  it("avoids a word Paul deletes from 3 drafts in different company (ANS-008's example)", () => {
    const edits = [
      edit("We can leverage our tooling here.", "We can use our tooling here."),
      edit("I can leverage the data to help.", "I can help."),
      edit("They leverage modern stacks.", "They build modern stacks."),
    ];
    expect(avoidedPhrases(edits)).toEqual(["leverage"]);
  });

  it("keeps the longest phrase that was deleted as often as its parts", () => {
    const edits = ["tooling", "platform", "data"].map((x) =>
      edit(`I can leverage our ${x} to help.`, "I can help."),
    );
    expect(avoidedPhrases(edits)).toEqual(["leverage our"]);
  });

  it("skips an edit longer than 2,000 words on either side", () => {
    const long = "word ".repeat(2001);
    const big = edit(`${long}I can leverage our tooling to help.`, `${long}I can help.`);
    expect(avoidedPhrases([big, cut(1), cut(2)])).toEqual([]);
  });

  it("doesn't avoid it after only 2 drafts", () => {
    expect(avoidedPhrases([cut(1), cut(2)])).toEqual([]);
  });

  it("counts a phrase deleted twice in one draft once", () => {
    const twice = edit(
      "I can leverage our tooling. We leverage our tooling daily.",
      "I can help. We work daily.",
    );
    expect(avoidedPhrases([twice, cut(1)])).toEqual([]);
  });
});

describe("findAvoided", () => {
  it("returns the positions of the avoided phrases a text contains, as whole words", () => {
    const avoid = ["leverage", "circle back", "synergy"];
    expect(findAvoided("We could Leverage it and circle  back later.", avoid)).toEqual([0, 1]);
    expect(findAvoided("Leveraged synergyless work.", avoid)).toEqual([]);
  });
});
