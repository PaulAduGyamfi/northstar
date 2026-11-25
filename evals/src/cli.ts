import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createLlmGateway,
  createRecordingClient,
  createReplayClient,
  type MessagesClient,
} from "@northstar/llm";
import { Baseline, compareToBaseline } from "./baseline.js";
import type { EvalReport, RegisteredEval } from "./types.js";

// Everything main() touches, injected so tests run offline against a temp folder.
export type CliDeps = {
  argv: string[];
  env: Record<string, string | undefined>;
  registry: Readonly<Record<string, RegisteredEval>>;
  // The evals/ folder: <root>/<route>/{cases.jsonl, baseline.json, fixtures/}.
  root: string;
  print: (line: string) => void;
  now: () => number;
  today: () => string;
  // Builds the real API client. Only --live and --record call it (they cost money).
  liveClient: (env: Record<string, string | undefined>) => MessagesClient;
};

type Mode = "replay" | "live" | "record";

// `eval <route> [--live | --record] [--update-baseline]`. Returns the process exit code.
export async function main(deps: CliDeps): Promise<number> {
  if (deps.argv[0] === "--all") return replayAll(deps);
  return runOne(deps);
}

// `eval --all`: replay every registered eval against its baseline (what CI runs, ADR-0013).
// Replay only: live runs cost money and happen one route at a time, on purpose.
async function replayAll(deps: CliDeps): Promise<number> {
  if (deps.argv.length > 1) {
    deps.print("--all only replays; run --live or --record one route at a time");
    return 1;
  }
  const names = Object.keys(deps.registry);
  const failed: string[] = [];
  for (const name of names) {
    if ((await runOne({ ...deps, argv: [name] })) !== 0) failed.push(name);
  }
  deps.print(
    failed.length === 0
      ? `all ${names.length} eval(s) at or above baseline`
      : `${failed.length} of ${names.length} eval(s) below baseline: ${failed.join(", ")}`,
  );
  return failed.length === 0 ? 0 : 1;
}

async function runOne(deps: CliDeps): Promise<number> {
  const [routeName, ...flags] = deps.argv;
  if (!routeName) {
    deps.print("usage: eval <route> [--live | --record] [--update-baseline]");
    return 1;
  }
  const evalSet = deps.registry[routeName];
  if (!evalSet) {
    const known = Object.keys(deps.registry).join(", ") || "none";
    deps.print(`unknown route: ${routeName} (known: ${known})`);
    return 1;
  }

  // Replay is the default: free, offline, and what CI runs (ADR-0013).
  const mode: Mode = flags.includes("--record")
    ? "record"
    : flags.includes("--live")
      ? "live"
      : "replay";
  const updateBaseline = flags.includes("--update-baseline");
  if (updateBaseline && mode === "replay") {
    deps.print("--update-baseline needs --live or --record");
    return 1;
  }

  const dir = join(deps.root, routeName);
  const casesPath = join(dir, "cases.jsonl");
  if (!existsSync(casesPath)) {
    deps.print(`no cases: evals/${routeName}/cases.jsonl`);
    return 1;
  }
  const cases = readFileSync(casesPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);

  const fixtures = join(dir, "fixtures");
  const client =
    mode === "replay"
      ? createReplayClient(fixtures)
      : mode === "record"
        ? createRecordingClient(deps.liveClient(deps.env), fixtures)
        : deps.liveClient(deps.env);
  const gateway = createLlmGateway({ client, now: deps.now });

  const report = await evalSet.run(gateway, cases);
  printReport(report, mode, deps.print);

  const baselinePath = join(dir, "baseline.json");
  if (updateBaseline) {
    // A baseline measures model quality. Cases lost to the API (a wrong key, an outage) or to a
    // missing fixture would lower the bar for every later run, so refuse.
    const infraFailures = report.cases.filter(
      (c) => c.outcome === "LlmTransportError" || c.outcome.startsWith("MissingFixture"),
    ).length;
    if (infraFailures > 0) {
      deps.print(
        `not updating the baseline: ${infraFailures} case(s) failed for API or fixture reasons, not model quality`,
      );
      return 1;
    }
    const baseline: Baseline = {
      passed: report.passed,
      total: report.total,
      model: report.model,
      promptVersion: report.promptVersion,
      date: deps.today(),
    };
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    deps.print(`baseline updated: evals/${routeName}/baseline.json`);
    return 0;
  }

  if (!existsSync(baselinePath)) {
    deps.print(`no baseline: run eval ${routeName} --live --update-baseline`);
    return 1;
  }
  const baseline = Baseline.safeParse(JSON.parse(readFileSync(baselinePath, "utf8")));
  if (!baseline.success) {
    deps.print(`invalid baseline: evals/${routeName}/baseline.json`);
    return 1;
  }
  const verdict = compareToBaseline(report, baseline.data);
  deps.print(verdict.line);
  return verdict.pass ? 0 : 1;
}

function printReport(report: EvalReport, mode: Mode, print: (line: string) => void) {
  print(`${report.route} (${mode}), prompt v${report.promptVersion}, ${report.model}`);
  for (const result of report.cases) {
    print(`  ${result.passed ? "pass" : "FAIL"} ${result.id} (${result.outcome})`);
  }
  const cost = report.costUsd === null ? "unknown" : `$${report.costUsd}`;
  print(`tokens ${report.inputTokens} in / ${report.outputTokens} out, cost ${cost}`);
}
