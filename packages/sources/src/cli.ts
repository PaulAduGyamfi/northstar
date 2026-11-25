import { basename } from "node:path";
import type { JobListItem, SetFieldError } from "@northstar/db";
import type { Result } from "@northstar/domain";
import { LlmTransportError } from "@northstar/llm";
import type { IngestResult } from "./ingest.js";

// `jobs add <url> | add --text <file> --url <url> | list | set <id> <field> <value>` (NS-114).
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
};

const USAGE =
  "usage: jobs add <url> | jobs add --text <file> --url <url> | jobs list | jobs set <job-id> <field> <value>";

export async function main(deps: CliDeps): Promise<number> {
  const [command, ...rest] = deps.argv;
  if (command === "add" && rest.length === 1 && rest[0])
    return report(deps, () => deps.addUrl(rest[0] ?? ""));
  if (command === "add" && rest.length === 4) {
    const file = flag(rest, "--text");
    const url = flag(rest, "--url");
    if (file && url) {
      const text = await deps.readText(file);
      deps.print(`Reading ${basename(file)} as the description for ${url}`);
      return report(deps, () => deps.addText(url, text));
    }
  }
  if (command === "list" && rest.length === 0) return listCommand(deps);
  if (command === "set" && rest.length >= 3) {
    const [id, field, ...value] = rest;
    if (id && field) return setCommand(deps, id, field, value.join(" "));
  }
  deps.print(USAGE);
  return 1;
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
  for (const j of jobs) {
    const when = j.postedAt ? `posted ${age(j.postedAt, now)}` : `seen ${age(j.firstSeenAt, now)}`;
    const draft = j.status === "draft" ? ` [draft: needs ${j.missingFields.join(", ")}]` : "";
    const sources = j.sources > 1 ? ` · ${j.sources} sources` : "";
    deps.print(
      `${j.id}  ${j.title ?? "?"} · ${j.company ?? "?"} · ${j.location ?? "location ?"} · ${when}${sources}${draft}`,
    );
  }
  return 0;
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
