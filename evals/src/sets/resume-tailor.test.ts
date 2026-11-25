import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gradeResumeTailor } from "./resume-tailor.js";

// The committed synthetic cases and their hand-written outputs (evals/resume-tailor/).
const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../resume-tailor/${name}`, import.meta.url)), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map(
      (l) => JSON.parse(l) as { id: string; input?: unknown; expected?: unknown; output?: unknown },
    );
const cases = new Map(read("cases.jsonl").map((c) => [c.id, c]));
const outputs = new Map(read("handwritten.jsonl").map((h) => [h.id, h.output]));
const grade = (id: string, output = outputs.get(id), expected = cases.get(id)?.expected) =>
  gradeResumeTailor(structuredClone(output), expected, cases.get(id)?.input);

describe("gradeResumeTailor", () => {
  it("passes a resume that rewords lines and adds a cited summary", () => {
    expect(grade("summary-and-terms")).toBe(true);
  });

  it("fails 120 million turned into 120 billion", () => {
    expect(grade("million-not-billion")).toBe(false);
  });

  it("fails a resume that drops a line, whatever its expectations", () => {
    const output = structuredClone(outputs.get("summary-and-terms")) as {
      sections: { lines: unknown[] }[];
    };
    output.sections[0]?.lines.pop();
    expect(grade("summary-and-terms", output)).toBe(false);
  });

  it("matches absent words whole and literally, so a symbol in one is no pattern", () => {
    expect(grade("summary-and-terms", undefined, { summary: true, absent: ["Go+", "rows."] })).toBe(
      true,
    );
    expect(grade("summary-and-terms", undefined, { summary: true, absent: ["led"] })).toBe(false);
    expect(grade("upgraded-verb", undefined, { summary: true, absent: ["le"] })).toBe(true);
  });
});
