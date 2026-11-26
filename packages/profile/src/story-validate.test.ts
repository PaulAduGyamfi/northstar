import { describe, expect, it } from "vitest";
import { StoryDraft } from "./story-schema.js";
import { unbackedNames, validateStoryDraft } from "./story-validate.js";

// A synthetic atom and interview (invented company and people).
const atom = {
  id: "8c0b3a52-4c4e-4c41-9d1e-0e6f6f3b9a01",
  sourceQuote: "Rebuilt the route planner for 40 depots at Example Freight.",
};

const answers = [
  {
    answer:
      "Drivers were getting routes at 6am that ignored road closures, so deliveries ran late.",
  },
  { answer: "I owned the route planner and had to fix it before peak season." },
  {
    answer:
      "I paired with the dispatch lead every morning for two weeks.\nThen I added a closures feed to the planner.",
  },
  { answer: "Late deliveries went from 12% to 3% in the first month." },
  { answer: "" },
];

const draft = (overrides: Partial<StoryDraft> = {}): StoryDraft => ({
  title: "Fixing routes before peak season",
  situation: {
    text: "Drivers were getting routes that ignored road closures, so deliveries ran late.",
    quotes: [
      "Drivers were getting routes at 6am that ignored road closures, so deliveries ran late.",
    ],
  },
  task: {
    text: "I owned the route planner and had to fix it before peak season.",
    quotes: ["I owned the route planner and had to fix it before peak season."],
  },
  action: {
    text: "I paired with the dispatch lead every morning, then added a closures feed to the planner.",
    quotes: [
      "I paired with the dispatch lead every morning for two weeks.",
      "Then I added a closures feed to the planner.",
    ],
  },
  result: {
    text: "Late deliveries across our 40 depots went from 12% to 3% in the first month.",
    quotes: ["Late deliveries went from 12% to 3% in the first month."],
  },
  atomIds: [atom.id],
  competencies: ["ownership", "collaboration"],
  followUps: [],
  ...overrides,
});

describe("validateStoryDraft", () => {
  it("a clean draft passes", () => {
    expect(validateStoryDraft(draft(), { atom, answers })).toEqual({ ok: true });
  });

  it("a quote that is not in Paul's answers is rejected", () => {
    const d = draft({
      task: { text: "I led the planner team.", quotes: ["I led the planner team."] },
    });
    expect(validateStoryDraft(d, { atom, answers })).toEqual({
      ok: false,
      failures: [{ item: "task", problem: "quote 0 is not in the answers" }],
    });
  });

  it("a quote cut from inside a longer number is rejected", () => {
    // "2% to 3%" is a substring of Paul's "12% to 3%", starting inside "12".
    const d = draft({
      result: {
        text: "Late deliveries went from 2% to 3% in the first month.",
        quotes: ["2% to 3% in the first month."],
      },
    });
    expect(validateStoryDraft(d, { atom, answers })).toEqual({
      ok: false,
      failures: [{ item: "result", problem: "quote 0 is not in the answers" }],
    });
  });

  it("a quote cut from inside a decimal is rejected", () => {
    const decimal = [{ answer: "Late deliveries went from 12.5% to 3% in the first month." }];
    const d = draft({
      result: {
        text: "Late deliveries went from 5% to 3%.",
        quotes: ["5% to 3% in the first month."],
      },
    });
    const result = validateStoryDraft(d, { atom, answers: [...answers, ...decimal] });
    expect(result.ok ? [] : result.failures.filter((f) => f.item === "result")).toEqual([
      { item: "result", problem: "quote 0 is not in the answers" },
    ]);
  });

  it("a one-word quote is rejected as too short", () => {
    const d = draft({ task: { text: "I owned the route planner.", quotes: ["owned"] } });
    expect(validateStoryDraft(d, { atom, answers })).toEqual({
      ok: false,
      failures: [{ item: "task", problem: "quote 0 is shorter than 2 words" }],
    });
  });

  it("a two-word quote of whole words passes", () => {
    const d = draft({ task: { text: "I owned the route planner.", quotes: ["route planner"] } });
    expect(validateStoryDraft(d, { atom, answers })).toEqual({ ok: true });
  });

  it("a number in the result that no quote or atom states is rejected", () => {
    const d = draft({
      result: {
        text: "Late deliveries went from 12% to 2% in the first month.",
        quotes: ["Late deliveries went from 12% to 3% in the first month."],
      },
    });
    expect(validateStoryDraft(d, { atom, answers })).toEqual({
      ok: false,
      failures: [{ item: "result", problem: "number 2 is not in its quotes or the atom" }],
    });
  });

  it("a number another part quotes does not count for this part", () => {
    const d = draft({
      situation: {
        text: "Deliveries ran late for 12% of drivers.",
        quotes: ["so deliveries ran late."],
      },
    });
    expect(validateStoryDraft(d, { atom, answers })).toEqual({
      ok: false,
      failures: [{ item: "situation", problem: "number 12 is not in its quotes or the atom" }],
    });
  });

  it("a number in the title that nothing states is rejected", () => {
    const d = draft({ title: "Cutting late deliveries by 75%" });
    expect(validateStoryDraft(d, { atom, answers })).toEqual({
      ok: false,
      failures: [{ item: "title", problem: "number 75 is not in the answers or the atom" }],
    });
  });

  it("a draft citing an atom outside the interview is rejected", () => {
    const d = draft({ atomIds: [atom.id, "11111111-2222-4333-8444-555555555555"] });
    expect(validateStoryDraft(d, { atom, answers })).toEqual({
      ok: false,
      failures: [{ item: "atomIds", problem: "atom 1 is not the interview's atom" }],
    });
  });

  it("a draft that does not cite the interview's atom is rejected", () => {
    const d = draft({ atomIds: [] });
    expect(validateStoryDraft(d, { atom, answers })).toEqual({
      ok: false,
      failures: [{ item: "atomIds", problem: "the interview's atom is not cited" }],
    });
  });

  it("a part with no quote is rejected", () => {
    const d = draft({ action: { text: "I fixed it.", quotes: [] } });
    expect(validateStoryDraft(d, { atom, answers })).toEqual({
      ok: false,
      failures: [{ item: "action", problem: "no quote" }],
    });
  });

  it("a quote that joins two different answers is rejected", () => {
    const d = draft({
      task: {
        text: "Deliveries ran late and I owned the planner.",
        quotes: ["so deliveries ran late. I owned the route planner"],
      },
    });
    expect(validateStoryDraft(d, { atom, answers })).toEqual({
      ok: false,
      failures: [{ item: "task", problem: "quote 0 is not in the answers" }],
    });
  });

  it("curly quotes and line breaks in answers do not cause a false rejection", () => {
    const typed = [
      { answer: "We couldn’t ship —\nthe planner   ignored closures." },
      ...answers.slice(1),
    ];
    const d = draft({
      situation: {
        text: "We couldn't ship: the planner ignored closures.",
        quotes: ["We couldn't ship - the planner ignored closures."],
      },
    });
    expect(validateStoryDraft(d, { atom, answers: typed })).toEqual({ ok: true });
  });

  it("lists every failure, naming parts and never quoting their text", () => {
    const d = draft({
      task: { text: "I led 9 people.", quotes: ["I led 9 people."] },
      atomIds: ["11111111-2222-4333-8444-555555555555"],
    });
    const result = validateStoryDraft(d, { atom, answers });
    expect(result).toEqual({
      ok: false,
      failures: [
        // The 9 sits in the invented quote, which already fails the draft.
        { item: "task", problem: "quote 0 is not in the answers" },
        { item: "atomIds", problem: "atom 0 is not the interview's atom" },
        { item: "atomIds", problem: "the interview's atom is not cited" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("led");
  });

  it("the draft schema refuses the same competency twice", () => {
    expect(StoryDraft.safeParse(draft({ competencies: ["scale", "scale"] })).success).toBe(false);
  });
});

describe("names in story text", () => {
  it("refuses a part that names a company no answer or the atom mentions", () => {
    const d = draft({
      task: {
        text: "I owned the route planner at Globex and had to fix it before peak season.",
        quotes: ["I owned the route planner and had to fix it before peak season."],
      },
    });
    expect(validateStoryDraft(d, { atom, answers })).toEqual({
      ok: false,
      failures: [{ item: "task", problem: "name at word 6 is not in the answers or the atom" }],
    });
  });

  it("passes names the atom holds and ordinary sentence openers", () => {
    const d = draft({
      result: {
        text: "Late deliveries went from 12% to 3% in the first month. Example Freight kept the feed.",
        quotes: ["Late deliveries went from 12% to 3% in the first month."],
      },
    });
    expect(validateStoryDraft(d, { atom, answers })).toEqual({ ok: true });
  });

  it("checks a sentence's first word when it is a name", () => {
    expect([
      unbackedNames("Globex asked me to fix it.", "they asked me to fix it", ""),
      unbackedNames("Then I fixed it. Drivers were happy.", "x", "drivers were late"),
      unbackedNames("I've fixed it and I'm glad.", "nothing", ""),
    ]).toEqual([[0], [], []]);
  });

  it("lets an opener through only by the part's own quotes, never by any answer", () => {
    // Paul once said "hit the target"; "Target" opening a sentence is still a name to check.
    expect(
      unbackedNames("I hit it. Target then hired me.", "we hit the target", "I hit it"),
    ).toEqual([3]);
  });

  it("checks mixed-case names, joined names and names that start with a digit", () => {
    // Positions: iOS at 3, ex-Globex at 6, planner/Initech at 8, 3M at 11.
    expect(
      unbackedNames(
        "We shipped the iOS app for ex-Globex and planner/Initech users at 3M.",
        "we shipped the app",
        "",
      ),
    ).toEqual([3, 6, 8, 11]);
  });

  it("passes the same names when the answers or the atom hold them", () => {
    expect(
      unbackedNames(
        "We shipped the iOS app for ex-Globex users at 3M.",
        "the iOS app at Globex, then 3M",
        "",
      ),
    ).toEqual([]);
  });

  it("lets only a sentence's first piece through as an opener", () => {
    // The part's quotes hold "re-globex" in lower case. Before NS-202 that let the whole word
    // through; now only its first piece is grammar, and "Globex" must be backed.
    expect(unbackedNames("Re-Globex the planner.", "we planned", "re-globex the planner")).toEqual([
      0,
    ]);
  });

  it("never takes a word that starts lower case as a sentence's opener", () => {
    // The part's quotes say "ios" in lower case; "iOS" opening a sentence is still a name.
    expect(unbackedNames("iOS shipped first.", "we shipped", "ios shipped first")).toEqual([0]);
  });

  it("still needs a capitalised joined word backed whole, not just its pieces", () => {
    // Both names are real, but the compound isn't: before NS-202 this was refused too.
    expect(
      unbackedNames("We built Globex-Initech together.", "at Globex, later Initech", ""),
    ).toEqual([2]);
  });

  it("needs a unit written with a capital to appear as written", () => {
    // "1M" counts as a name-shaped word: "1 million" in the sources doesn't back it (fail safe).
    expect([
      unbackedNames("We served 1M users.", "we served 1 million users", ""),
      unbackedNames("We served 1M users.", "we served 1M users", ""),
    ]).toEqual([[2], []]);
  });

  it("reads a possessive as its name", () => {
    expect(unbackedNames("We fixed Example Freight's planner.", "at Example Freight", "")).toEqual(
      [],
    );
  });

  it("refuses a number in words that the part's quotes don't hold", () => {
    const d = draft({
      task: {
        text: "I owned the route planner for a team of twenty and had to fix it before peak season.",
        quotes: ["I owned the route planner and had to fix it before peak season."],
      },
    });
    expect(validateStoryDraft(d, { atom, answers })).toEqual({
      ok: false,
      failures: [
        { item: "task", problem: "number word at word 9 is not in its quotes or the atom" },
      ],
    });
  });

  it("passes a number in words that the part's quote holds", () => {
    const d = draft({
      action: {
        text: "I paired with the dispatch lead every morning for two weeks.",
        quotes: ["I paired with the dispatch lead every morning for two weeks."],
      },
    });
    expect(validateStoryDraft(d, { atom, answers })).toEqual({ ok: true });
  });
});
