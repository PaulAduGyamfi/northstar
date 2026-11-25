import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLlmGateway, createReplayClient } from "@northstar/llm";
import { describe, expect, it } from "vitest";
import { writeHandwrittenFixtures } from "./handwrite.js";
import { testCases, testEval } from "./test/test-eval.js";

const OUTPUTS = [
  { label: "remote", confidence: 0.9 },
  { label: "remote", confidence: 0.8 },
  // Deliberately wrong, as a hand-written failure would be.
  { label: "remote", confidence: 0.6 },
];

describe("writeHandwrittenFixtures", () => {
  it("writes fixtures that replay to the same result, each marked hand-written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "handwritten-"));
    const written = await writeHandwrittenFixtures(testEval, testCases, OUTPUTS, dir, "test note");
    expect(written.passed).toBe(2);

    const files = readdirSync(dir);
    expect(files).toHaveLength(3);
    for (const f of files) {
      const file = JSON.parse(readFileSync(join(dir, f), "utf8"));
      expect([file.handWritten, file.response.id.startsWith("msg_handwritten_")]).toEqual([
        "test note",
        true,
      ]);
    }

    const replay = createLlmGateway({ client: createReplayClient(dir), now: () => 0 });
    const replayed = await testEval.run(replay, testCases);
    expect(replayed.cases).toEqual(written.cases);
  });

  it("refuses to write where a recorded fixture already is", async () => {
    const dir = mkdtempSync(join(tmpdir(), "handwritten-"));
    writeFileSync(join(dir, "abc.json"), JSON.stringify({ requestSha256: "abc", response: {} }));
    await expect(writeHandwrittenFixtures(testEval, testCases, OUTPUTS, dir, "n")).rejects.toThrow(
      "1 recorded fixture(s) here: hand-written ones can't replace them",
    );
  });

  it("writes again over its own hand-written fixtures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "handwritten-"));
    await writeHandwrittenFixtures(testEval, testCases, OUTPUTS, dir, "n");
    const again = await writeHandwrittenFixtures(testEval, testCases, OUTPUTS, dir, "n");
    expect(again.passed).toBe(2);
  });

  it("refuses when the outputs don't line up with the cases", async () => {
    const dir = mkdtempSync(join(tmpdir(), "handwritten-"));
    await expect(
      writeHandwrittenFixtures(testEval, testCases, OUTPUTS.slice(1), dir, "n"),
    ).rejects.toThrow("3 case(s) but 2 hand-written output(s)");
  });
});
