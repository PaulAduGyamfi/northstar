import { basename } from "node:path";
import type { JobListItem, SetFieldError } from "@northstar/db";
import type { Result } from "@northstar/domain";
import { describeHeldBack, HeldBack, LlmTransportError } from "@northstar/llm";
import { FIT_USAGE, type FitCliDeps, fitCommand, scoreAfter } from "./fit/cli.js";
import type { IngestResult } from "./ingest.js";
import type { CheckPassSummary } from "./liveness.js";
import { ageHours, freshness, queueScore } from "./queue.js";
import { type BoardCliDeps, pollCommand, runCommand, watchCommand } from "./watch-cli.js";

// `jobs add <url> | add --text <file> --url <url> | list | set <id> <field> <value>` (NS-114),
// plus `jobs watch …`, `jobs poll` and `jobs run` (NS-115, watch-cli.ts), and `jobs prefs …`,
// `jobs score` and `jobs why` (NS-116, fit/cli.ts).
// Everything is injected, so tests run with no database, network or model.
export type CliDeps = {
  argv: string[];
  print: (line: string) => void;
  now: () => Date;
  addUrl: (url: string) => Promise<IngestResult>;
  addText: (url: string, text: string) => Promise<IngestResult>;
  readText: (path: string) => Promise<string>;
  list: () => Promise<JobListItem[]>;
  set: (
    jobId: string,
    field: string,
    value: string,
  ) => Promise<Result<{ status: "draft" | "ready"; missingFields: string[] }, SetFieldError>>;
  boards: BoardCliDeps;
  fit: FitCliDeps;
  // One liveness pass over the jobs due a re-check (NS-173, SRC-010).
  check: () => Promise<CheckPassSummary>;
};

const USAGE = `usage: jobs add <url> | jobs add --text <file> --url <url> | jobs list | jobs set <job-id> <field> <value>\n       jobs watch add <board-url> --tier 1|2|3 | jobs watch list | jobs watch remove|retry <id> | jobs poll | jobs run\n       jobs check\n${FIT_USAGE}`;

export async function main(deps: CliDeps): Promise<number> {
  const [command, ...rest] = deps.argv;
  if (command === "add" && rest.length === 1 && rest[0])
    return scored(deps, await report(deps, () => deps.addUrl(rest[0] ?? "")));
  if (command === "add" && rest.length === 4) {
    const file = flag(rest, "--text");
    const url = flag(rest, "--url");
    if (file && url) {
      const text = await deps.readText(file);
      deps.print(`Reading ${basename(file)} as the description for ${url}`);
      return scored(deps, await report(deps, () => deps.addText(url, text)));
    }
  }
  if (command === "list" && rest.length === 0) return listCommand(deps);
  if (command === "watch") {
    const code = await watchCommand(deps, rest);
    if (code !== null) return code;
  }
  if (command === "poll" && rest.length === 0) return pollCommand(deps);
  if (command === "run" && rest.length === 0) return runCommand(deps);
  if (command === "check" && rest.length === 0) return checkCommand(deps);
  if (command === "set" && rest.length >= 3) {
    const [id, field, ...value] = rest;
    if (id && field) return scored(deps, await setCommand(deps, id, field, value.join(" ")));
  }
  const fit = await fitCommand(deps, deps.argv);
  if (fit !== null) return fit;
  deps.print(USAGE);
  return 1;
}

// A new or edited job is scored straight away (NS-116); a failed command scores nothing.
async function scored(deps: CliDeps, code: number): Promise<number> {
  if (code === 0) await scoreAfter(deps);
  return code;
}

const flag = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const METHOD: Record<string, string> = {
  ats_api: "the job board's API",
  jsonld: "the page's structured data",
  model: "the page text, read by the model",
  text: "your saved description, read by the model",
};

async function report(deps: CliDeps, run: () => Promise<IngestResult>): Promise<number> {
  let r: IngestResult;
  try {
    r = await run();
  } catch (error) {
    if (error instanceof LlmTransportError) {
      deps.print(
        `Not added: the Claude API didn't answer (status ${error.status ?? "none"}). Try again later.`,
      );
      return 1;
    }
    // A kill switch or breaker (NS-174): the model was never called.
    if (error instanceof HeldBack) {
      deps.print(`Not added: ${describeHeldBack(error)}. Try again later.`);
      return 1;
    }
    // Named, never quoted: a message could echo page or database content.
    deps.print(`Not added: ${error instanceof Error ? error.name : "an unknown error"}.`);
    return 1;
  }
  switch (r.status) {
    case "refused":
      deps.print(`Not added: ${r.reason}.`);
      return 1;
    case "failed":
      deps.print(`Not added: ${r.reason}. Nothing was stored; try again later.`);
      return 1;
    case "not_a_job":
      deps.print(
        "Not added: that page isn't a single job posting (a list of jobs, a login page or similar).",
      );
      return 1;
    case "unchanged":
      deps.print(`Already added (job ${r.jobId}). Nothing changed.`);
      return 0;
    case "merged":
      deps.print(`Same role as job ${r.jobId}; added this link as another source.`);
      return 0;
    case "created": {
      deps.print(`Added job ${r.jobId} from ${r.method ? (METHOD[r.method] ?? r.method) : "?"}.`);
      if (r.found.length > 0) deps.print(`  Found: ${r.found.join(", ")}.`);
      if (r.dropped.length > 0) {
        deps.print(`  Left out (not on the page): ${r.dropped.join(", ")}.`);
      }
      if (r.missing.length > 0) {
        deps.print(
          `  Draft: ${r.missing.join(" and ")} not found. Fill in with: jobs set ${r.jobId} <field> <value>`,
        );
      }
      if (r.record) {
        const cost = r.record.costUsd === null ? "cost unknown" : `$${r.record.costUsd}`;
        deps.print(`  Model ${r.record.modelServed}, prompt v${r.record.promptVersion}, ${cost}.`);
      }
      return 0;
    }
  }
}

// "3 h ago", "2 d ago": freshness at a glance (SRC-009).
function age(from: Date, now: Date): string {
  const hours = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 3_600_000));
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

async function listCommand(deps: CliDeps): Promise<number> {
  const jobs = await deps.list();
  if (jobs.length === 0) {
    deps.print("No jobs yet. Add one with: jobs add <url>");
    return 0;
  }
  const now = deps.now();
  // Freshness × fit (SRC-013); a job not scored yet is ordered by freshness alone.
  const score = (j: JobListItem) =>
    queueScore(freshness(ageHours(j.postedAt, j.firstSeenAt, now)), fitOf(j.fit));
  const ordered = [...jobs].sort((a, b) => score(b) - score(a));
  for (const j of ordered) {
    const when = j.postedAt ? `posted ${age(j.postedAt, now)}` : `seen ${age(j.firstSeenAt, now)}`;
    const draft = j.status === "draft" ? ` [draft: needs ${j.missingFields.join(", ")}]` : "";
    const sources = j.sources > 1 ? ` · ${j.sources} sources` : "";
    deps.print(
      `${j.id}  ${j.title ?? "?"} · ${j.company ?? "?"} · ${j.location ?? "location ?"} · ${when}${sources}${fitLabel(j.fit)}${draft}`,
    );
  }
  return 0;
}

// The fit the queue multiplies by. A "no_evidence" score (nothing in the posting or the
// preferences to judge by) isn't a measurement, so that job is ordered by freshness alone.
function fitOf(fit: JobListItem["fit"]): number | null {
  return fit && fit.reason !== "no_evidence" ? fit.score / 100 : null;
}

// " · fit 82 queue", " · fit 55 skip (below_threshold:title)", " · fit 71 suggest stretch",
// or nothing for a job not scored yet.
function fitLabel(fit: JobListItem["fit"]): string {
  if (!fit) return "";
  if (fit.reason === "no_evidence") return " · fit ? suggest (no_evidence)";
  const reason = fit.band === "skip" ? ` (${fit.reason})` : "";
  return ` · fit ${fit.score} ${fit.band}${fit.stretch ? " stretch" : ""}${reason}`;
}

async function setCommand(
  deps: CliDeps,
  id: string,
  field: string,
  value: string,
): Promise<number> {
  const r = await deps.set(id, field, value);
  if (!r.ok) {
    const e = r.error;
    deps.print(
      e.kind === "NotFound"
        ? `No job ${id}.`
        : e.kind === "NotEditable"
          ? `${e.field} can't be set by hand. Editable: title, company, location, remote, salaryMin, salaryMax, seniority, applyUrl.`
          : `That isn't a valid ${e.field}.`,
    );
    return 1;
  }
  deps.print(
    r.value.status === "ready"
      ? `Saved. Job ${id} is ready.`
      : `Saved. Job ${id} still needs: ${r.value.missingFields.join(", ")}.`,
  );
  return 0;
}

// `jobs check`: re-check the postings of saved jobs not checked in a day (SRC-010). Counts only.
async function checkCommand(deps: CliDeps): Promise<number> {
  const s = await deps.check();
  deps.print(
    `Checked ${s.checked} posting${s.checked === 1 ? "" : "s"}: ${s.open} open, ${s.closed} closed, ${s.unavailable} couldn't be reached${s.heldBack > 0 ? `, ${s.heldBack} held back by a switch or breaker` : ""}`,
  );
  return 0;
}
