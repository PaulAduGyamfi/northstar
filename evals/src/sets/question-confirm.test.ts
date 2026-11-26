import { describe, expect, it } from "vitest";
import { gradeQuestionConfirm } from "./question-confirm.js";

describe("gradeQuestionConfirm", () => {
  it("passes exactly the expected index, or null when null is expected", () => {
    expect([
      gradeQuestionConfirm({ choice: 1 }, { choice: 1 }),
      gradeQuestionConfirm({ choice: null }, { choice: null }),
    ]).toEqual([true, true]);
  });

  it("fails a guess where null was expected, and a wrong index", () => {
    expect([
      gradeQuestionConfirm({ choice: 0 }, { choice: null }),
      gradeQuestionConfirm({ choice: 0 }, { choice: 1 }),
    ]).toEqual([false, false]);
  });

  it("fails output that carries a question instead of an index", () => {
    expect(
      gradeQuestionConfirm({ choice: "Tell me about a time you failed." }, { choice: 0 }),
    ).toBe(false);
  });
});
