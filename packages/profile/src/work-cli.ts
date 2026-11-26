import { basename } from "node:path";
import type {
  IndependentWorkView,
  OfficialPosition,
  SetIndependentWorkResult,
} from "@northstar/db";
import {
  type AnswerSource,
  independentWorkSection,
  parseIndependentWork,
  sinceFromFacts,
  twentySecondAnswer,
  type WorkEntry,
} from "./independent-work.js";

// `profile work set <file>` and `profile work show` (NS-196, DX-010): Paul's independent work
// since his last role, the "Projects / Independent work" section and the 20-second answer. `set`
// prints counts only; `show` prints Paul's own entries back to Paul in his terminal.

export type WorkCliDeps = {
  print: (line: string) => void;
  readText: (path: string) => Promise<string>;
  readFacts: () => Promise<OfficialPosition[]>;
  setIndependentWork: (entries: WorkEntry[]) => Promise<SetIndependentWorkResult>;
  readIndependentWork: () => Promise<IndependentWorkView | null>;
};

export const WORK_USAGE = "usage: profile work set <file> | profile work show";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function workCommand(deps: WorkCliDeps, args: string[]): Promise<number> {
  const [sub, path, ...rest] = args;
  if (sub === "set" && path && rest.length === 0) return workSetCommand(deps, path);
  if (sub === "show" && path === undefined) return workShowCommand(deps);
  deps.print(WORK_USAGE);
  return 1;
}

// Reads Paul's file and stores it as the next version; a file with any bad line stores nothing.
async function workSetCommand(deps: WorkCliDeps, path: string): Promise<number> {
  const name = basename(path);
  const parsed = parseIndependentWork(await deps.readText(path));
  if (!parsed.ok) {
    deps.print(`${name}: nothing stored. Fix these lines first:`);
    for (const p of parsed.error) deps.print(`  line ${p.line}: ${p.problem}`);
    return 1;
  }
  const result = await deps.setIndependentWork(parsed.value);
  const counts = `${plural(result.entries, "entry", "entries")}, ${plural(result.lines, "line")}`;
  deps.print(
    result.status === "set"
      ? `${name}: stored version ${result.version} (${counts}).`
      : `${name}: unchanged, still version ${result.version} (${counts}).`,
  );
  return 0;
}

// Where a part of the answer came from, in words Paul can check against his file.
function sourceLine(s: AnswerSource, entries: readonly WorkEntry[]): string {
  if (s.part === "since") return `official record: ${s.employer}, ended ${s.month}`;
  const title = entries[s.entry]?.title ?? "?";
  return s.part === "title"
    ? `entry ${s.entry + 1} (${title}): its title`
    : `entry ${s.entry + 1} (${title}): line ${s.line + 1}`;
}

async function workShowCommand(deps: WorkCliDeps): Promise<number> {
  const work = await deps.readIndependentWork();
  if (work === null) {
    deps.print("No independent work stored yet. Run: profile work set data/<file>");
    return 0;
  }
  deps.print(`Version ${work.version}`);
  deps.print("");
  for (const line of independentWorkSection(work.entries)) deps.print(line);
  deps.print("");
  const answer = twentySecondAnswer(work.entries, sinceFromFacts(await deps.readFacts()));
  deps.print("What have you been doing since? (about 20 seconds)");
  if (!answer.ok) {
    deps.print(
      answer.reason === "no_entries"
        ? "  Nothing to say yet."
        : "  It doesn't fit in 20 seconds: shorten the newest entry's title.",
    );
    return 0;
  }
  deps.print(`  ${answer.text}`);
  deps.print(`  (${answer.words} words) From:`);
  for (const s of answer.sources) deps.print(`  - ${sourceLine(s, work.entries)}`);
  return 0;
}
