import { basename } from "node:path";
import {
  COMPETENCIES,
  type OfficialPosition,
  type ProfileView,
  type SetFactsResult,
  type StoryView,
} from "@northstar/db";
import { LlmTransportError } from "@northstar/llm";
import { type Claim, checkEmploymentFacts, type Mismatch, parseOfficialRecord } from "./facts.js";
import type { ImportResult } from "./import.js";
import type { InterviewOutcome } from "./interview.js";

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
  // The guided story interview (NS-111), with Paul's terminal already wired in by bin.ts.
  runInterview: (atomId?: string) => Promise<InterviewOutcome>;
  readStories: () => Promise<StoryView[]>;
  // The official employment record and its consistency check (NS-112, DX-011).
  setFacts: (positions: OfficialPosition[]) => Promise<SetFactsResult>;
  readFacts: () => Promise<OfficialPosition[]>;
  recordCheck: (claims: number, mismatches: Mismatch[]) => Promise<void>;
};

const USAGE =
  "usage: profile import-resume <path> [--reimport] | profile show | profile interview [--atom <id>] | profile stories | profile facts set <file> | profile facts check";

// `profile import-resume <path>`, `profile show`, `profile interview` and `profile stories`.
// Import output is counts only, never resume text; `show`, `interview` and `stories` show Paul's
// own profile and stories back to Paul in his terminal.
export async function main(deps: CliDeps): Promise<number> {
  const [command, path, ...flags] = deps.argv;
  if (command === "import-resume" && path) {
    return importCommand(deps, path, flags.includes("--reimport"));
  }
  if (command === "show") return showCommand(deps);
  if (command === "interview") {
    const rest = deps.argv.slice(1);
    if (rest.length === 0) return interviewCommand(deps);
    if (rest.length === 2 && rest[0] === "--atom" && rest[1])
      return interviewCommand(deps, rest[1]);
  }
  if (command === "stories" && deps.argv.length === 1) return storiesCommand(deps);
  if (command === "facts" && path === "set" && flags.length === 1 && flags[0]) {
    return factsSetCommand(deps, flags[0]);
  }
  if (command === "facts" && path === "check" && flags.length === 0) return factsCheckCommand(deps);
  deps.print(USAGE);
  return 1;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// `profile facts set <file>`: stores Paul's official employment record. A file with any bad line
// stores nothing.
async function factsSetCommand(deps: CliDeps, path: string): Promise<number> {
  const name = basename(path);
  const parsed = parseOfficialRecord(await deps.readText(path));
  if (!parsed.ok) {
    deps.print(`Not stored: ${name} has problems. Nothing was changed.`);
    for (const e of parsed.error) deps.print(`  line ${e.line}: ${e.problem}`);
    return 1;
  }
  const result = await deps.setFacts(parsed.value);
  deps.print(
    result.status === "set"
      ? `Official record set: ${plural(result.positions, "position")}.`
      : `Official record unchanged (${plural(result.positions, "position")}).`,
  );
  return 0;
}

const SOURCE_LABEL: Record<Claim["source"], string> = {
  resume: "Resume",
  linkedin: "LinkedIn",
  site: "Site",
  application_form: "Application form",
};

// `profile facts check`: the current resume's roles against the official record (DX-011). Exits 1
// on any mismatch so it can gate a script. Shows Paul's own facts back to Paul only.
async function factsCheckCommand(deps: CliDeps): Promise<number> {
  const official = await deps.readFacts();
  if (official.length === 0) {
    deps.print(
      "No official record yet. Write it in data/ (Employer | Title | start | end per line) and run: profile facts set <file>",
    );
    return 1;
  }
  const view = await deps.readProfile();
  if (!view) {
    deps.print("No resume imported yet. Run: import-resume <path>");
    return 1;
  }
  const claims: Claim[] = view.roles.map((r) => ({
    source: "resume",
    employer: r.employer,
    title: r.title,
    start: r.startMonth,
    end: r.endMonth,
    current: r.current,
  }));
  const mismatches = checkEmploymentFacts(official, claims);
  await deps.recordCheck(claims.length, mismatches);
  for (const m of mismatches) {
    const what =
      m.field === "employer"
        ? "employer isn't in the official record"
        : `${m.field} says ${m.claimed ?? "?"}, official record says ${m.official ?? "?"}`;
    deps.print(`${SOURCE_LABEL[m.source]} · ${m.employer} · ${m.title}: ${what}`);
  }
  if (mismatches.length === 0) {
    deps.print(
      `All ${plural(claims.length, "resume role")} ${claims.length === 1 ? "agrees" : "agree"} with the official record.`,
    );
    return 0;
  }
  deps.print(
    `${plural(mismatches.length, "mismatch", "mismatches")}. Fix the resume to match the official record, then re-import it.`,
  );
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
  // Drizzle wraps driver errors (DrizzleQueryError, named plain "Error", with the query and its
  // parameters in the message): describe the pg error it carries instead, the same safe way.
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && typeof (cause as { code?: unknown }).code === "string") {
    return safeErrorSummary(cause);
  }
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

async function interviewCommand(deps: CliDeps, atomId?: string): Promise<number> {
  let outcome: InterviewOutcome;
  try {
    outcome = await deps.runInterview(atomId);
  } catch (error) {
    if (error instanceof LlmTransportError) {
      deps.print(
        `The Claude API didn't answer (status ${error.status ?? "none"}). Your answers are saved; run \`profile interview\` again later.`,
      );
      return 1;
    }
    deps.print(`Interview stopped: ${safeErrorSummary(error)}. Answers given so far are saved.`);
    return 1;
  }
  switch (outcome.kind) {
    case "approved": {
      // Every call of the interview (follow-ups, redrafts), not just the last one.
      const rs = outcome.records;
      const last = rs.at(-1);
      const sum = (f: (r: (typeof rs)[number]) => number) => rs.reduce((n, r) => n + f(r), 0);
      const cost = rs.some((r) => r.costUsd === null)
        ? "cost unknown"
        : `$${Math.round(sum((r) => r.costUsd ?? 0) * 1e8) / 1e8}`;
      deps.print(
        `Model ${last?.modelServed ?? "?"}, prompt v${last?.promptVersion ?? "?"}, ${rs.length} call(s), ${sum((r) => r.inputTokens)} in / ${sum((r) => r.outputTokens)} out tokens, ${cost}.`,
      );
      deps.print(
        "Run `profile interview` for the next atom, or `profile stories` to read them back.",
      );
      return 0;
    }
    case "skipped":
    case "stopped":
      return 0;
    case "no_atoms":
      deps.print(
        "No atom left to interview about: import a resume first, or every atom has a story.",
      );
      return 0;
    case "atom_not_found":
      deps.print("No atom with that id in your profile.");
      return 1;
  }
}

async function storiesCommand(deps: CliDeps): Promise<number> {
  const stories = await deps.readStories();
  if (stories.length === 0) {
    deps.print("No stories yet. Run: profile interview");
  }
  for (const s of stories) {
    deps.print(`${s.title} [${s.competencies.join(", ")}]`);
    deps.print(`  Situation: ${s.situation}`);
    deps.print(`  Task: ${s.task}`);
    deps.print(`  Action: ${s.action}`);
    deps.print(`  Result: ${s.result}`);
  }
  // Which competencies have no story yet (CPG-003): where the next interview helps most.
  const covered = new Set(stories.flatMap((s) => s.competencies));
  const missing = COMPETENCIES.filter((c) => !covered.has(c));
  deps.print(
    missing.length === 0
      ? "Every competency has a story."
      : `No story yet for: ${missing.join(", ")}`,
  );
  return 0;
}
