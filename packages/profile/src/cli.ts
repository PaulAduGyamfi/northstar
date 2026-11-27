import { basename } from "node:path";
import {
  COMPETENCIES,
  type ImportReport,
  type OfficialPosition,
  type ProfileImportInput,
  type ProfileView,
  type SaveThesisResult,
  type SetFactsResult,
  type SourceRole,
  type StoryView,
  type ThesisProfile,
  type ThesisView,
} from "@northstar/db";
import { describeHeldBack, HeldBack, LlmTransportError } from "@northstar/llm";
import { type AuditCliDeps, auditCommand } from "./audit-cli.js";
import { type ContactCliDeps, contactCommand } from "./contact-cli.js";
import { type DnaCliDeps, dnaCommand, refreshAfterChange } from "./dna-cli.js";
import { type Claim, checkEmploymentFacts, type Mismatch, parseOfficialRecord } from "./facts.js";
import { type GrowthCliDeps, growthCommand } from "./growth-cli.js";
import type { ImportResult } from "./import.js";
import type { InterviewOutcome } from "./interview.js";
import { describeLinkedinProblem, type LinkedinFiles, parseLinkedinExport } from "./linkedin.js";
import {
  answerCommand,
  type SettingsDeps,
  settingsSetCommand,
  settingsShowCommand,
} from "./settings-cli.js";
import { parseSiteText } from "./site.js";
import { parseDrop, type TailorCliDeps, tailorCommand } from "./tailor-cli.js";
import { type ThesisDraftResult, thesisProblems } from "./thesis-draft.js";
import { type VoiceCliDeps, voiceCommand } from "./voice-cli.js";
import { type WorkCliDeps, workCommand } from "./work-cli.js";

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
  // The positioning thesis (NS-152, DX-009). bin.ts decides whether drafting is on.
  readThesisProfile: () => Promise<ThesisProfile | null>;
  draftTheses: (profile: ThesisProfile, asOf: string) => Promise<ThesisDraftResult>;
  saveThesis: (text: string, atomIds: string[]) => Promise<SaveThesisResult>;
  readThesis: () => Promise<ThesisView | null>;
  // Today's month (YYYY-MM) for "N years", from the clock bin.ts passes in.
  month: () => string;
  // The LinkedIn data export (NS-133): its CSVs from a folder (null when Positions.csv is
  // missing), the store, and the current import's roles for `facts check`.
  readLinkedinExport: (folder: string) => Promise<LinkedinFiles | null>;
  storeImport: (input: Omit<ProfileImportInput, "candidateId">) => Promise<ImportReport>;
  readLinkedinRoles: () => Promise<SourceRole[] | null>;
} & SettingsDeps &
  TailorCliDeps &
  AuditCliDeps &
  WorkCliDeps &
  GrowthCliDeps &
  VoiceCliDeps &
  ContactCliDeps &
  DnaCliDeps;

const USAGE =
  'usage: profile import-resume <path> [--reimport] | profile show | profile interview [--atom <id>] | profile stories | profile facts set <file> | profile facts check | profile thesis draft | profile thesis set "<text>" --atoms <id,id> | profile thesis show | profile import-linkedin <folder>';
// Their own line for the NS-141 commands: the line above stays as it was.
const SETTINGS_USAGE =
  'usage: profile settings set <field> <value> [--for <qualifier>] | profile settings show | profile answer "<question>"';
const TAILOR_USAGE = "usage: profile tailor <job-id> [--drop <skill,skill>]";

// `profile import-resume <path>`, `profile show`, `profile interview` and `profile stories`.
// Import output is counts only, never resume text; `show`, `interview` and `stories` show Paul's
// own profile and stories back to Paul in his terminal.
export async function main(deps: CliDeps): Promise<number> {
  const [command, path, ...flags] = deps.argv;
  if (command === "import-resume" && path) {
    return importCommand(deps, path, flags.includes("--reimport"));
  }
  if (command === "show") return showCommand(deps);
  if (command === "import-linkedin" && path && flags.length === 0) {
    return importLinkedinCommand(deps, path);
  }
  // Paul's personal site, from a file he saved (NS-209).
  if (command === "import-site" && path && flags.length === 0) {
    return importSiteCommand(deps, path);
  }
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
  if (command === "thesis" && path === "draft" && flags.length === 0)
    return thesisDraftCommand(deps);
  if (command === "thesis" && path === "show" && flags.length === 0) return thesisShowCommand(deps);
  if (command === "thesis" && path === "set" && flags.length === 3 && flags[1] === "--atoms") {
    const [text, , atoms] = flags;
    const atomIds = (atoms ?? "")
      .split(",")
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
    if (text && text.trim().length > 0 && atomIds.length > 0) {
      return thesisSetCommand(deps, text.trim(), atomIds);
    }
  }
  // Profile settings and factual answers (NS-141).
  if (command === "settings" && path === "show" && flags.length === 0)
    return settingsShowCommand(deps);
  if (command === "settings" && path === "set") {
    const [field, value, forFlag, qualifier] = flags;
    if (field && value !== undefined && flags.length === 2)
      return settingsSetCommand(deps, field, value);
    if (field && value !== undefined && flags.length === 4 && forFlag === "--for" && qualifier)
      return settingsSetCommand(deps, field, value, qualifier);
  }
  if (command === "answer" && path && path.trim().length > 0 && flags.length === 0)
    return answerCommand(deps, path);
  // Tailoring a stored job (NS-146).
  if (command === "tailor" && path) {
    const drop = parseDrop(flags);
    if (drop) return tailorCommand(deps, path, drop);
  }
  if (command === "tailor") {
    deps.print(TAILOR_USAGE);
    return 1;
  }
  // The resume audit and Paul's decisions (NS-190): its own usage line, like tailor's.
  if (command === "audit") return auditCommand(deps, deps.argv.slice(1));
  // Independent work since the last role (NS-196): its own usage line, like audit's.
  if (command === "work") return workCommand(deps, deps.argv.slice(1));
  // Growth tracks, touches, settings and the week's plan (NS-210).
  if (command === "growth") return growthCommand(deps, deps.argv.slice(1));
  // The voice profile from Paul's writing samples, and his review of its phrases (NS-222).
  if (command === "voice") return voiceCommand(deps, deps.argv.slice(1));
  // Paul's contact details for application packages (NS-227): its own usage line.
  if (command === "contact") return contactCommand(deps, deps.argv.slice(1));
  // The Career DNA report from the stored profile, saved when it changed (NS-130 slice 5).
  if (command === "dna") return dnaCommand(deps, deps.argv.slice(1));
  deps.print(command === "settings" || command === "answer" ? SETTINGS_USAGE : USAGE);
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
  // The LinkedIn export's positions too, once one is imported (NS-133).
  const linkedin = (await deps.readLinkedinRoles()) ?? [];
  for (const r of linkedin) {
    claims.push({
      source: "linkedin",
      employer: r.employer,
      title: r.title,
      start: r.startMonth,
      end: r.endMonth,
      current: r.current,
    });
  }
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
    const what =
      linkedin.length === 0
        ? plural(claims.length, "resume role")
        : `${plural(claims.length - linkedin.length, "resume role")} and ${plural(linkedin.length, "LinkedIn position")}`;
    deps.print(`All ${what} ${claims.length === 1 ? "agrees" : "agree"} with the official record.`);
    return 0;
  }
  // Where to fix it: the resume (as always), or LinkedIn itself when a position there disagrees.
  const fix = mismatches.some((m) => m.source === "linkedin")
    ? "Fix the resume or your LinkedIn profile to match the official record, then re-import the changed one."
    : "Fix the resume to match the official record, then re-import it.";
  deps.print(`${plural(mismatches.length, "mismatch", "mismatches")}. ${fix}`);
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
      // A new import changes the Career DNA report's atoms (DNA-008).
      await refreshAfterChange(deps);
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
  // A kill switch or breaker held the model call back (NS-206): name it, from its fixed fields.
  if (error instanceof HeldBack) return `held back (${describeHeldBack(error)})`;
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
      // An approved story counts toward the Career DNA report (DNA-008).
      await refreshAfterChange(deps);
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

const FAILED_DRAFT = {
  refused: "was a refusal",
  truncated: "was cut off",
  invalid_output: "wasn't in the expected shape",
} as const;

const NO_PROFILE = "No resume imported yet. Run: import-resume <path>";

// `profile thesis draft`: up to three candidates that passed checkThesis, with the atoms each
// cites. Nothing is saved; Paul picks one and runs `thesis set`.
async function thesisDraftCommand(deps: CliDeps): Promise<number> {
  const profile = await deps.readThesisProfile();
  if (!profile) {
    deps.print(NO_PROFILE);
    return 1;
  }
  let result: ThesisDraftResult;
  try {
    result = await deps.draftTheses(profile, deps.month());
  } catch (error) {
    if (error instanceof LlmTransportError) {
      deps.print(
        `The Claude API didn't answer (status ${error.status ?? "none"}). Nothing was saved; try again later.`,
      );
      return 1;
    }
    throw error;
  }
  switch (result.kind) {
    case "skipped":
      deps.print(
        result.reason === "off"
          ? 'Thesis drafting is off until its eval fixtures are recorded. Write your own and run: profile thesis set "<text>" --atoms <id,id>'
          : "Your profile has no atoms to cite. Import a resume first.",
      );
      return result.reason === "off" ? 0 : 1;
    case "failed":
      deps.print(`No draft: the model's answer ${FAILED_DRAFT[result.reason]}. Nothing was saved.`);
      return 1;
    case "drafted": {
      result.theses.forEach((t, i) => {
        deps.print(`${i + 1}. ${t.text}`);
        deps.print(`   atoms: ${t.atomIds.join(",")}`);
      });
      if (result.dropped > 0) {
        deps.print(
          `${plural(result.dropped, "draft")} dropped: ${result.dropped === 1 ? "it says" : "each says"} something your resume doesn't.`,
        );
      }
      if (result.theses.length === 0) {
        deps.print("No draft passed the check. Write your own and run: profile thesis set");
        return 1;
      }
      deps.print(
        'Pick one (edit it if you like) and run: profile thesis set "<text>" --atoms <id,id>',
      );
      return 0;
    }
  }
}

// `profile thesis set "<text>" --atoms <id,id>`: checkThesis first (plain code, ADR-0004); any
// failure saves nothing.
async function thesisSetCommand(deps: CliDeps, text: string, atomIds: string[]): Promise<number> {
  const profile = await deps.readThesisProfile();
  if (!profile) {
    deps.print(NO_PROFILE);
    return 1;
  }
  const problems = thesisProblems({ text, atomIds }, profile, deps.month());
  if (problems.length > 0) {
    deps.print("Not saved: the thesis says something its atoms don't back. Nothing was changed.");
    for (const p of problems) deps.print(`  ${describeProblem(p)}`);
    return 1;
  }
  const saved = await deps.saveThesis(text, [...new Set(atomIds)]);
  if (!saved.ok) {
    const e = saved.error;
    deps.print(
      e.kind === "AtomNotCurrent"
        ? `Not saved: ${e.atomIds.join(",")} not in your current resume import.`
        : e.kind === "NoAtoms"
          ? "Not saved: cite at least one atom."
          : "Not saved: a thesis is one line of at most 200 characters.",
    );
    return 1;
  }
  deps.print(
    saved.saved
      ? `Thesis saved as version ${saved.version}.`
      : `Thesis unchanged (version ${saved.version}).`,
  );
  return 0;
}

function describeProblem(p: ReturnType<typeof thesisProblems>[number]): string {
  switch (p.kind) {
    case "unknown_atom":
      return `atom ${p.id} isn't in your profile`;
    case "no_citation":
      return "cite at least one atom from your profile";
    case "not_one_sentence":
      return "write one sentence";
    case "unbacked_number":
      return `"${p.token}" isn't in a cited atom (or more years than your roles span)`;
    case "unbacked_name":
      return `"${p.token}" isn't in a cited atom, your roles or your skills`;
  }
}

// `profile thesis show`: the current thesis, its version and the atoms it cites.
async function thesisShowCommand(deps: CliDeps): Promise<number> {
  const thesis = await deps.readThesis();
  if (!thesis) {
    deps.print("No thesis yet. Run: profile thesis draft");
    return 0;
  }
  deps.print(thesis.text);
  deps.print(`Version ${thesis.version}, atoms: ${thesis.atomIds.join(",")}`);
  return 0;
}

// `profile import-linkedin <folder>`: Paul's unzipped LinkedIn export, parsed by plain code (no
// model) and stored as its own source. Counts only: never a position or a line.
async function importLinkedinCommand(deps: CliDeps, folder: string): Promise<number> {
  const name = basename(folder);
  const files = await deps.readLinkedinExport(folder);
  if (!files) {
    deps.print(`Not imported: ${name} has no Positions.csv. Unzip your LinkedIn export there.`);
    return 1;
  }
  const parsed = parseLinkedinExport(files);
  if (!parsed.ok) {
    deps.print(`Not imported: ${describeLinkedinProblem(parsed.error)}. Nothing was written.`);
    return 1;
  }
  const report = await deps.storeImport({
    kind: "linkedin",
    fileName: name,
    textSha256: parsed.value.textSha256,
    // No model: version 0 and "none" mark a deterministic import.
    promptVersion: 0,
    model: "none",
    traceId: null,
    call: {},
    extract: parsed.value.extract,
  });
  if (report.status === "unchanged") {
    deps.print("Your LinkedIn export is unchanged since the last import. Nothing to do.");
    return 0;
  }
  const c = report.counts;
  deps.print(
    `Imported your LinkedIn export: ${plural(c.roles, "position")}, ${c.education} education, ${plural(c.atoms, "atom")}, ${plural(c.skills, "skill")}.`,
  );
  deps.print("Run `profile facts check` to compare it with your official record.");
  // Its lines are Career DNA evidence (NS-130 slice 7), so a new export rebuilds the report.
  await refreshAfterChange(deps);
  return 0;
}

// `profile import-site <file>` (NS-209): Paul's personal site, from a file he saved himself, as its
// own source. Prints counts only. A file with any bad line stores nothing.
async function importSiteCommand(deps: CliDeps, path: string): Promise<number> {
  const name = basename(path);
  const parsed = parseSiteText(await deps.readText(path));
  if (!parsed.ok) {
    deps.print(`Not imported: ${name} has lines to fix first. Nothing was written.`);
    for (const p of parsed.error)
      deps.print(p.line > 0 ? `  line ${p.line}: ${p.problem}` : `  ${p.problem}`);
    return 1;
  }
  const report = await deps.storeImport({
    kind: "site",
    fileName: name,
    textSha256: parsed.value.textSha256,
    // No model: version 0 and "none" mark a deterministic import.
    promptVersion: 0,
    model: "none",
    traceId: null,
    call: {},
    extract: parsed.value.extract,
  });
  if (report.status === "unchanged") {
    deps.print("Your site file is unchanged since the last import. Nothing to do.");
    return 0;
  }
  deps.print(
    `Imported your site: ${plural(parsed.value.projects, "project")}, ${plural(report.counts.atoms, "atom")}, ${plural(report.counts.links, "link")}.`,
  );
  // Its lines are Career DNA evidence too (NS-130 slice 7).
  await refreshAfterChange(deps);
  return 0;
}
