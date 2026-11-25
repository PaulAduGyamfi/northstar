import { describe, expect, it } from "vitest";
import { gradeVerificationExtract } from "./verification-extract.js";

describe("gradeVerificationExtract", () => {
  it("passes exactly the expected index, or null when null is expected", () => {
    expect([
      gradeVerificationExtract({ choice: 1 }, { choice: 1 }),
      gradeVerificationExtract({ choice: null }, { choice: null }),
    ]).toEqual([true, true]);
  });

  it("fails a guess where null was expected, and a wrong index", () => {
    expect([
      gradeVerificationExtract({ choice: 0 }, { choice: null }),
      gradeVerificationExtract({ choice: 0 }, { choice: 1 }),
    ]).toEqual([false, false]);
  });

  it("fails output that carries a code instead of an index", () => {
    expect(gradeVerificationExtract({ choice: "111111" }, { choice: 0 })).toBe(false);
  });
});
