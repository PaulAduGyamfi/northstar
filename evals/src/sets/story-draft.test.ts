import { describe, expect, it } from "vitest";
import { gradeStoryDraft } from "./story-draft.js";

// A synthetic atom and interview (invented company and people).
const input = {
  atom: {
    id: "8c0b3a52-4c4e-4c41-9d1e-0e6f6f3b9a01",
    what: "Rebuilt the route planner",
    sourceQuote: "Rebuilt the route planner for 40 depots at Example Freight.",
  },
  answers: [
    { question: "Situation?", answer: "Routes ignored road closures, so deliveries ran late." },
    { question: "Task?", answer: "I owned the route planner." },
    { question: "Action?", answer: "I added a closures feed to the planner." },
    { question: "Result?", answer: "Late deliveries went from 12% to 3%." },
  ],
};

const output = {
  title: "Routing around closures",
  situation: {
    text: "Routes ignored road closures, so deliveries ran late.",
    quotes: ["Routes ignored road closures, so deliveries ran late."],
  },
  task: { text: "I owned the route planner.", quotes: ["I owned the route planner."] },
  action: {
    text: "I added a closures feed to the planner.",
    quotes: ["I added a closures feed to the planner."],
  },
  result: {
    text: "Late deliveries went from 12% to 3%.",
    quotes: ["Late deliveries went from 12% to 3%."],
  },
  atomIds: [input.atom.id],
  competencies: ["ownership"],
  followUps: [],
};

const expected = { competenciesAnyOf: ["ownership", "technical-depth"], followUps: false };

describe("gradeStoryDraft", () => {
  it("passes a faithful draft with an expected competency", () => {
    expect(gradeStoryDraft(output, expected, input)).toBe(true);
  });

  it("fails a draft the provenance check rejects", () => {
    const invented = {
      ...output,
      result: { text: "Late deliveries fell by 90%.", quotes: ["fell by 90%"] },
    };
    expect(gradeStoryDraft(invented, expected, input)).toBe(false);
  });

  it("fails when none of the expected competencies is tagged", () => {
    expect(gradeStoryDraft(output, { ...expected, competenciesAnyOf: ["conflict"] }, input)).toBe(
      false,
    );
  });

  it("fails when follow-ups were expected and none were asked", () => {
    expect(gradeStoryDraft(output, { ...expected, followUps: true }, input)).toBe(false);
  });

  it("fails when follow-ups were asked for a story that holds", () => {
    const asking = { ...output, followUps: ["Who else was involved?"] };
    expect(gradeStoryDraft(asking, expected, input)).toBe(false);
  });

  it("fails when an absent string appears, ignoring case", () => {
    expect(gradeStoryDraft(output, { ...expected, absent: ["ROUTE PLANNER"] }, input)).toBe(false);
  });
});
