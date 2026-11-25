import { basename } from "node:path";
import type { ProfileView } from "@northstar/db";
import { LlmTransportError } from "@northstar/llm";
import type { ImportResult } from "./import.js";

// Everything main() touches, injected so tests run with no database, model or file.
export type CliDeps = {
  argv: string[];
  print: (line: string) => void;
  readText: (path: string) => Promise<string>;
  runImport: (
    fileName: string,
    text: string,
    options: { reimport: boolean },
  ) => Promise<ImportResult>;
  readProfile: () => Promise<ProfileView | null>;
};

// `profile import-resume <path>` and `profile show`. Import output is counts only, never resume
// text; `show` reads Paul's own profile back to Paul in his terminal.
export async function main(deps: CliDeps): Promise<number> {
  const [command, path, ...flags] = deps.argv;
  if (command === "import-resume" && path) {
    return importCommand(deps, path, flags.includes("--reimport"));
  }
  if (command === "show") return showCommand(deps);
  deps.print("usage: profile import-resume <path> [--reimport] | profile show");
  return 1;
}

async function importCommand(deps: CliDeps, path: string, reimport: boolean): Promise<number> {
  const name = basename(path);
  let result: ImportResult;
  try {
    result = await deps.runImport(name, await deps.readText(path), { reimport });
  } catch (error) {
    if (error instanceof LlmTransportError) {
      deps.print(
        `Not imported: the Claude API didn't answer (status ${error.status ?? "none"}). Nothing was written; try again later.`,
      );
      return 1;
    }
    deps.print(`Not imported: ${safeErrorSummary(error)}. Nothing was written.`);
    return 1;
  }
  switch (result.kind) {
    case "unchanged":
      deps.print(`${name} is unchanged since the last import. Nothing to do.`);
      return 0;
    case "imported": {
      const c = result.counts;
      const r = result.record;
      deps.print(
        `Imported ${name}: ${c.roles} roles, ${c.education} education, ${c.atoms} atoms, ${c.skills} skills, ${c.certifications} certifications, ${c.links} links.`,
      );
      deps.print(
        `Model ${r.modelServed}, prompt v${r.promptVersion}, ${r.inputTokens} in / ${r.outputTokens} out tokens, ${r.costUsd === null ? "cost unknown" : `$${r.costUsd}`}.`,
      );
      deps.print("Run `show` to read it back.");
      return 0;
    }
    case "rejected":
      deps.print(
        "Not imported: the extraction said something the resume doesn't. Nothing was written.",
      );
      for (const f of result.failures) deps.print(`  ${f.item} ${f.index}: ${f.problem}`);
      deps.print("Re-run to try again, or check that resume line.");
      return 1;
    case "model":
      deps.print(`Not imported: the model's answer was ${result.outcome}. Nothing was written.`);
      return 1;
  }
}

// An error described without its message or details: a Postgres error's `detail` ("Failing row
// contains (...)") and some messages quote row values, which here would be resume text. Name, pg
// code and constraint name only. File errors from fileToText start with the file name and never
// quote contents, so their message is kept. "Not found" includes the local path: fine for Paul's
// terminal, but never put this summary in an event, span or log.
export function safeErrorSummary(error: unknown): string {
  if (!(error instanceof Error)) return "an unknown error";
  const e = error as Error & { code?: unknown; constraint?: unknown };
  const parts: string[] = [];
  if (typeof e.code === "string") parts.push(`code ${e.code}`);
  if (typeof e.constraint === "string") parts.push(`constraint ${e.constraint}`);
  if (parts.length > 0) return `${e.name} (${parts.join(", ")})`;
  if (/^[^\s:]+\.(txt|md|docx|pdf|pages|[a-z0-9]+): /i.test(e.message)) return e.message;
  return e.name;
}

async function showCommand(deps: CliDeps): Promise<number> {
  const view = await deps.readProfile();
  if (!view) {
    deps.print("No resume imported yet. Run: import-resume <path>");
    return 0;
  }
  for (const r of view.roles) {
    deps.print(
      `${r.employer} · ${r.title} · ${r.startMonth ?? "?"} – ${r.current ? "present" : (r.endMonth ?? "?")} (locked)`,
    );
    for (const atom of r.atoms) deps.print(`  - ${atom}`);
  }
  if (view.unassignedAtoms.length > 0) {
    deps.print("Other");
    for (const atom of view.unassignedAtoms) deps.print(`  - ${atom}`);
  }
  if (view.skills.length > 0) deps.print(`Skills: ${view.skills.join(", ")}`);
  return 0;
}
