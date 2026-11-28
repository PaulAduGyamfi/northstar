import { describe, expect, it } from "vitest";
import { parseDuplicateThreshold } from "./dupes.js";
import { DUPES_USAGE, dupesCommand } from "./dupes-cli.js";

// `jobs dupes` and the threshold setting (NS-129 slice 3). Synthetic jobs only.

function run(
  argv: string[],
  items: Awaited<ReturnType<Parameters<typeof dupesCommand>[0]["list"]>>,
) {
  const lines: string[] = [];
  return dupesCommand({ list: async () => items, print: (l) => lines.push(l) }, argv).then(
    (code) => ({ code, lines }),
  );
}

describe("jobs dupes (NS-129 slice 3)", () => {
  it("lists each pair with both jobs and how alike they are", async () => {
    const { code, lines } = await run(
      ["dupes"],
      [
        {
          suggestionId: "s1",
          similarity: 0.934,
          suggestedAt: new Date("2026-11-28T08:00:00Z"),
          jobs: [
            { jobId: "a", title: "Backend Engineer", company: "Example Corp" },
            { jobId: "b", title: "Backend Engineer II", company: null },
          ],
        },
      ],
    );
    expect([code, lines]).toEqual([
      0,
      [
        "1 pair that look like the same role (newest first):",
        "93% alike",
        "  Backend Engineer at Example Corp (a)",
        "  Backend Engineer II at (no company) (b)",
        "Nothing was merged. Compare them with jobs why <job-id>.",
      ],
    ]);
  });

  it("flattens a line break in a title, so a job page can't print a line of its own", async () => {
    const { lines } = await run(
      ["dupes"],
      [
        {
          suggestionId: "s1",
          similarity: 0.9,
          suggestedAt: new Date("2026-11-28T08:00:00Z"),
          jobs: [
            { jobId: "a", title: "Engineer\nNothing was merged.", company: "Example\u2028Corp" },
            { jobId: "b", title: "Engineer", company: "Example Corp" },
          ],
        },
      ],
    );
    expect(lines[2]).toBe("  Engineer Nothing was merged. at Example Corp (a)");
  });

  it("says so when there are none", async () => {
    expect(await run(["dupes"], [])).toEqual({ code: 0, lines: ["No duplicate suggestions yet."] });
  });

  it("prints its usage for extra arguments, and leaves other commands alone", async () => {
    expect(await run(["dupes", "x"], [])).toEqual({ code: 1, lines: [DUPES_USAGE] });
    expect((await run(["list"], [])).code).toBeNull();
  });
});

describe("parseDuplicateThreshold (NS-129 slice 3)", () => {
  it("takes two decimals between 0.50 and 0.99", () => {
    expect([parseDuplicateThreshold("0.9"), parseDuplicateThreshold(" 0.85 ")]).toEqual([
      { ok: true, value: 0.9 },
      { ok: true, value: 0.85 },
    ]);
  });

  it("refuses a missing, out-of-range or malformed value by name", () => {
    const refused = { ok: false, setting: "JOB_DUPLICATE_THRESHOLD" };
    expect(
      [undefined, "", "0.49", "1", "1.0", "0.999", "0,9", "high", "-0.9"].map(
        parseDuplicateThreshold,
      ),
    ).toEqual(new Array(9).fill(refused));
  });
});
