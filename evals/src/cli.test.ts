import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmTransportError, type MessagesClient } from "@northstar/llm";
import { beforeEach, describe, expect, it } from "vitest";
import { type CliDeps, main } from "./cli.js";
import { messagesAnswering, testCases, testEval } from "./test/test-eval.js";

let root: string;
let printed: string[];
let liveCalls: number;

// An eval folder in a temp dir with the synthetic cases and a baseline of `passed`/3.
function writeEvalFolder(passed: number) {
  const dir = join(root, "test-classify");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "cases.jsonl"),
    `${testCases.map((c) => JSON.stringify(c)).join("\n")}\n`,
  );
  writeFileSync(
    join(dir, "baseline.json"),
    JSON.stringify({
      passed,
      total: 3,
      model: "claude-opus-5-5",
      promptVersion: 1,
      date: "2026-11-24",
    }),
  );
}

// Deps for main(). The "live" client is a fake that labels everything remote and counts calls.
const deps = (argv: string[]): CliDeps => ({
  argv,
  env: {},
  registry: { "test-classify": testEval },
  root,
  print: (line) => printed.push(line),
  now: () => 0,
  today: () => "2026-11-25",
  liveClient: (): MessagesClient => {
    const inner = messagesAnswering("remote");
    return {
      create: (params, options) => {
        liveCalls += 1;
        return inner.create(params, options);
      },
    };
  },
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "evals-"));
  printed = [];
  liveCalls = 0;
});

describe("eval cli", () => {
  it("rejects an unknown route and lists the known ones", async () => {
    expect(await main(deps(["nonexistent"]))).toBe(1);
    expect(printed).toEqual(["unknown route: nonexistent (known: test-classify)"]);
  });

  it("records with --record, then replays offline and passes at the baseline", async () => {
    writeEvalFolder(2);
    expect(await main(deps(["test-classify", "--record"]))).toBe(0);
    expect(liveCalls).toBe(3);

    printed = [];
    expect(await main(deps(["test-classify"]))).toBe(0);
    // Replay made no live call.
    expect(liveCalls).toBe(3);
    expect(printed).toEqual([
      "test-classify (replay), prompt v1, claude-opus-5-5",
      "  pass remote-1 (Ok)",
      "  pass remote-2 (Ok)",
      "  FAIL onsite-1 (Ok)",
      // 3 calls × (100 in × $4 + 10 out × $20 per million tokens)
      "tokens 300 in / 30 out, cost $0.0018",
      "test-classify: 2/3 passed, baseline 2/3: ok",
    ]);
  });

  it("exits 1 when replay scores below the baseline", async () => {
    writeEvalFolder(3);
    await main(deps(["test-classify", "--record"]));
    printed = [];
    expect(await main(deps(["test-classify"]))).toBe(1);
    expect(printed.at(-1)).toBe("test-classify: 2/3 passed, baseline 3/3: BELOW BASELINE");
  });

  it("fails every case with MissingFixture when nothing was recorded", async () => {
    writeEvalFolder(2);
    expect(await main(deps(["test-classify"]))).toBe(1);
    expect(printed[1]).toMatch(/^ {2}FAIL remote-1 \(MissingFixture /);
    expect(liveCalls).toBe(0);
  });

  it("writes a new baseline only from a live or recording run", async () => {
    writeEvalFolder(3);
    expect(await main(deps(["test-classify", "--update-baseline"]))).toBe(1);
    expect(printed).toEqual(["--update-baseline needs --live or --record"]);

    expect(await main(deps(["test-classify", "--live", "--update-baseline"]))).toBe(0);
    const written = JSON.parse(readFileSync(join(root, "test-classify", "baseline.json"), "utf8"));
    expect(written).toEqual({
      passed: 2,
      total: 3,
      model: "claude-opus-5-5",
      promptVersion: 1,
      date: "2026-11-25",
    });
  });

  it("refuses to write a baseline when any case failed for an API or fixture reason", async () => {
    writeEvalFolder(3);
    const failing = (argv: string[]): CliDeps => ({
      ...deps(argv),
      liveClient: () => ({
        create: async () => {
          throw new LlmTransportError({ status: 401, retryable: false });
        },
      }),
    });
    // A live run where every call fails with 401 (say, a wrong key) must not become a 0/3 baseline.
    expect(await main(failing(["test-classify", "--live", "--update-baseline"]))).toBe(1);
    expect(printed.at(-1)).toBe(
      "not updating the baseline: 3 case(s) failed for API or fixture reasons, not model quality",
    );
    const kept = JSON.parse(readFileSync(join(root, "test-classify", "baseline.json"), "utf8"));
    expect(kept.passed).toBe(3);
  });

  it("names the missing fixture's key so it can be re-recorded", async () => {
    writeEvalFolder(2);
    await main(deps(["test-classify"]));
    expect(printed[1]).toMatch(/^ {2}FAIL remote-1 \(MissingFixture [0-9a-f]{64}\)$/);
  });

  it("--all replays every registered eval and fails if any does", async () => {
    writeEvalFolder(2);
    await main(deps(["test-classify", "--record"]));
    printed = [];
    expect(await main(deps(["--all"]))).toBe(0);
    expect(printed.at(-1)).toBe("all 1 eval(s) at or above baseline");

    writeEvalFolder(3);
    printed = [];
    expect(await main(deps(["--all"]))).toBe(1);
    expect(printed.at(-1)).toBe("1 of 1 eval(s) below baseline: test-classify");
  });

  it("--all refuses --live and --record: CI only ever replays", async () => {
    expect(await main(deps(["--all", "--live"]))).toBe(1);
    expect(printed).toEqual(["--all only replays; run --live or --record one route at a time"]);
  });

  it("says where the cases file should be when it is missing", async () => {
    expect(await main(deps(["test-classify"]))).toBe(1);
    expect(printed).toEqual(["no cases: evals/test-classify/cases.jsonl"]);
  });
});
