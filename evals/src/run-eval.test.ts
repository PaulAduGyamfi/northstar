import { describe, expect, it } from "vitest";
import { compareToBaseline } from "./baseline.js";
import { exactField, fieldsSubset, schemaOnly } from "./graders.js";
import { alwaysRemoteGateway, testCases, testEval } from "./test/test-eval.js";

describe("graders", () => {
  it("fieldsSubset passes when every expected field matches", () => {
    expect(fieldsSubset({ label: "remote", confidence: 0.2 }, { label: "remote" })).toBe(true);
    expect(fieldsSubset({ label: "onsite", confidence: 0.2 }, { label: "remote" })).toBe(false);
  });

  it("fieldsSubset compares nested values by content", () => {
    expect(fieldsSubset({ tags: ["a", "b"] }, { tags: ["a", "b"] })).toBe(true);
    expect(fieldsSubset({ tags: ["a"] }, { tags: ["a", "b"] })).toBe(false);
  });

  it("exactField compares one named field", () => {
    const grade = exactField("label");
    expect(grade({ label: "remote" }, { label: "remote" })).toBe(true);
    expect(grade({ label: "remote" }, { label: "onsite" })).toBe(false);
  });

  it("schemaOnly passes any output that reached it (the gateway already checked the schema)", () => {
    expect(schemaOnly({ anything: 1 }, {})).toBe(true);
  });
});

describe("runEval", () => {
  it("reports exact pass counts, per-case results, tokens and cost", async () => {
    const report = await testEval.run(alwaysRemoteGateway, testCases);
    expect(report).toEqual({
      route: "test-classify",
      promptVersion: 1,
      model: "claude-opus-5-5",
      passed: 2,
      total: 3,
      inputTokens: 300,
      outputTokens: 30,
      costUsd: 0.0018,
      cases: [
        { id: "remote-1", outcome: "Ok", passed: true },
        { id: "remote-2", outcome: "Ok", passed: true },
        { id: "onsite-1", outcome: "Ok", passed: false },
      ],
    });
  });
});

describe("compareToBaseline", () => {
  const report = {
    route: "test-classify",
    promptVersion: 1,
    model: "claude-opus-5-5",
    passed: 2,
    total: 3,
    inputTokens: 300,
    outputTokens: 30,
    costUsd: 0.0018,
    cases: [],
  };
  const baseline = (passed: number, total = 3) => ({
    passed,
    total,
    model: "claude-opus-5-5",
    promptVersion: 1,
    date: "2026-11-24",
  });

  it("fails when the pass count drops below the baseline", () => {
    expect(compareToBaseline(report, baseline(3))).toEqual({
      pass: false,
      line: "test-classify: 2/3 passed, baseline 3/3: BELOW BASELINE",
    });
  });

  it("passes when the pass count equals or beats the baseline", () => {
    expect(compareToBaseline(report, baseline(2)).pass).toBe(true);
    expect(compareToBaseline(report, baseline(1))).toEqual({
      pass: true,
      line: "test-classify: 2/3 passed, baseline 1/3: ok",
    });
  });

  it("fails when the number of cases changed, so the baseline must be redone", () => {
    expect(compareToBaseline(report, baseline(2, 4))).toEqual({
      pass: false,
      line: "test-classify: 2/3 passed, baseline 2/4: CASE COUNT CHANGED, re-baseline with --live",
    });
  });
});
