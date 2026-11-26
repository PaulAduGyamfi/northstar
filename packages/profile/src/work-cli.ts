import { basename } from "node:path";
import type {
  IndependentWorkView,
  OfficialPosition,
  SetIndependentWorkResult,
} from "@northstar/db";
import {
  type AnswerSource,
  independentWorkSection,
  LINKEDIN_DESCRIPTION_MAX,
  linkedinProjects,
  parseIndependentWork,
  sinceFromFacts,
  twentySecondAnswer,
  type WorkEntry,
} from "./independent-work.js";

// `profile work set <file>`, `profile work show` (NS-196, DX-010) and `profile work linkedin`
// (NS-231 slice 2): Paul's independent work since his last role, the "Projects / Independent
// work" section, the 20-second answer and LinkedIn "Projects" fields to paste. `set` prints counts
// only; `show` and `linkedin` print Paul's own entries back to Paul in his terminal.

export type WorkCliDeps = {
  print: (line: string) => void;
  readText: (path: string) => Promise<string>;
  readFacts: () => Promise<OfficialPosition[]>;
  setIndependentWork: (entries: WorkEntry[]) => Promise<SetIndependentWorkResult>;
  readIndependentWork: () => Promise<IndependentWorkView | null>;
};

export const WORK_USAGE =
  "usage: profile work set <file> | profile work show | profile work linkedin";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function workCommand(deps: WorkCliDeps, args: string[]): Promise<number> {
  const [sub, path, ...rest] = args;
  if (sub === "set" && path && rest.length === 0) return workSetCommand(deps, path);
  if (sub === "show" && path === undefined) return workShowCommand(deps);
  if (sub === "linkedin" && path === undefined) return workLinkedinCommand(deps);
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

// LinkedIn "Projects" fields to paste by hand (NS-231 slice 2): Paul's own entries, printed to his
// own terminal. Nothing is sent to LinkedIn (ADR-0003).
async function workLinkedinCommand(deps: WorkCliDeps): Promise<number> {
  const work = await deps.readIndependentWork();
  if (work === null) {
    deps.print(NOTHING_STORED);
    return 0;
  }
  deps.print(
    `LinkedIn Projects from version ${work.version}. Paste each field; nothing is sent to LinkedIn.`,
  );
  linkedinProjects(work.entries).forEach((p, i) => {
    deps.print("");
    deps.print(`Project ${i + 1}`);
    deps.print(`  Name: ${p.name}`);
    deps.print(`  Start: ${p.start}`);
    deps.print(`  End: ${p.end ?? "I am currently working on this"}`);
    if (p.link !== null) deps.print(`  Project URL: ${p.link}`);
    deps.print("  Description:");
    for (const line of p.description.split("\n")) deps.print(`  ${line}`);
    if (p.tooLong) {
      deps.print(
        `  Too long for LinkedIn: ${p.length} of ${LINKEDIN_DESCRIPTION_MAX} characters. Shorten these lines in your file.`,
      );
    }
  });
  return 0;
}

const NOTHING_STORED = "No independent work stored yet. Run: profile work set data/<file>";

async function workShowCommand(deps: WorkCliDeps): Promise<number> {
  const work = await deps.readIndependentWork();
  if (work === null) {
    deps.print(NOTHING_STORED);
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
