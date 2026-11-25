import type {
  FitScoreView,
  Preferences,
  PreferenceValues,
  SavePreferencesResult,
} from "@northstar/db";
import { PREFERENCE_DEFAULTS } from "@northstar/db";
import { applyPreference, isPreferenceField, PREFERENCE_FIELDS, showPreference } from "./prefs.js";
import type { ScoreCounts, ScoreRun } from "./run.js";
import type { Evidence } from "./score.js";

// `jobs prefs`, `jobs prefs set <field> <value>`, `jobs score` and `jobs why <job-id>` (NS-116).
// Injected, like cli.ts, so tests run with no database.
export type FitCliDeps = {
  preferences: () => Promise<Preferences | null>;
  savePreferences: (values: PreferenceValues) => Promise<SavePreferencesResult>;
  score: () => Promise<ScoreRun>;
  recordRescore: (preference: Preferences, counts: ScoreCounts) => Promise<void>;
  why: (jobId: string) => Promise<FitScoreView | null>;
  atomTexts: (ids: string[]) => Promise<Map<string, string>>;
};

export type FitIo = { print: (line: string) => void; fit: FitCliDeps };

export const FIT_USAGE =
  "       jobs prefs | jobs prefs set <field> <value> | jobs score | jobs why <job-id>";

export async function fitCommand(io: FitIo, argv: string[]): Promise<number | null> {
  const [command, ...rest] = argv;
  if (command === "prefs" && rest.length === 0) return showPrefs(io);
  if (command === "prefs" && rest[0] === "set" && rest.length >= 3) {
    return setPref(io, rest[1] ?? "", rest.slice(2).join(" "));
  }
  if (command === "score" && rest.length === 0) return scoreCommand(io);
  if (command === "why" && rest.length === 1) return whyCommand(io, rest[0] ?? "");
  return null;
}

async function showPrefs(io: FitIo): Promise<number> {
  const current = await io.fit.preferences();
  io.print(
    current
      ? `Search preferences, version ${current.version}:`
      : "No search preferences yet. Defaults until you set one:",
  );
  const values = current ?? PREFERENCE_DEFAULTS;
  for (const f of PREFERENCE_FIELDS) io.print(`  ${f}: ${showPreference(values, f)}`);
  io.print("Change one with: jobs prefs set <field> <value>   (- clears it)");
  return 0;
}

async function setPref(io: FitIo, field: string, raw: string): Promise<number> {
  const current = await io.fit.preferences();
  const next = applyPreference(current ?? PREFERENCE_DEFAULTS, field, raw);
  if (!next.ok) {
    const e = next.error;
    io.print(
      e.kind === "UnknownField"
        ? `No preference called ${e.field}. Fields: ${PREFERENCE_FIELDS.join(", ")}.`
        : `Not saved: ${e.field} must be ${e.why}.`,
    );
    return 1;
  }
  const saved = await io.fit.savePreferences(next.value);
  if (saved.status === "unchanged") {
    const shown = isPreferenceField(field) ? showPreference(next.value, field) : raw;
    io.print(`${field} is already ${shown}. Nothing changed.`);
    return 0;
  }
  // SRC-017: the change takes effect now, on every open job, without a restart.
  let run: ScoreRun;
  try {
    run = await io.fit.score();
  } catch (error) {
    // The new version is stored either way; the next pass (jobs score, jobs run) re-scores.
    const name = error instanceof Error ? error.name : "an unknown error";
    io.print(
      `Preferences changed (version ${saved.current.version}); scoring didn't run (${name}). Run: jobs score`,
    );
    return 0;
  }
  const before = saved.previous ?? PREFERENCE_DEFAULTS;
  const changes = saved.changed
    .filter(isPreferenceField)
    .map((f) => `${f} ${showPreference(before, f)} → ${showPreference(saved.current, f)}`)
    .join(", ");
  if (run.status !== "done") {
    io.print(`Preferences changed: ${changes || "first version saved"}. ${missing(run.status)}`);
    return 0;
  }
  await io.fit.recordRescore(saved.current, run.counts);
  io.print(
    `Preferences changed: ${changes || "first version saved"}; ${plural(run.counts.jobs, "job")} re-scored.`,
  );
  if (run.counts.failed > 0) io.print(`  ${run.counts.failed} couldn't be saved; run jobs score.`);
  return 0;
}

const missing = (status: "no_profile" | "no_preferences") =>
  status === "no_profile"
    ? "Nothing scored yet: import your resume first (profile import-resume)."
    : "Nothing scored yet: set a preference first (jobs prefs set <field> <value>).";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function scoreLine(run: ScoreRun): string | null {
  if (run.status !== "done") return missing(run.status);
  const c = run.counts;
  if (c.jobs === 0 && c.failed === 0) return null;
  const failed = c.failed > 0 ? `, ${c.failed} failed` : "";
  return `Scored ${plural(c.jobs, "job")}: ${c.queue} to queue, ${c.suggest} suggested, ${c.skip} skipped${failed}.`;
}

async function scoreCommand(io: FitIo): Promise<number> {
  const run = await io.fit.score();
  io.print(scoreLine(run) ?? "Every job is already scored.");
  return run.status === "done" && run.counts.failed === 0 ? 0 : 1;
}

// After `jobs add`, `jobs set` and each poll pass: score what's new, quietly. A missing resume
// or preferences isn't repeated here (`jobs score` says so); a scoring failure never fails the
// command that ran first.
export async function scoreAfter(io: FitIo): Promise<void> {
  try {
    const run = await io.fit.score();
    const line = run.status === "done" ? scoreLine(run) : null;
    if (line) io.print(line);
  } catch (error) {
    // Named, never quoted: a database error's detail can quote a row.
    io.print(`Scoring didn't run (${error instanceof Error ? error.name : "an unknown error"}).`);
  }
}

// Posting text on one line: a requirement with line breaks in it can't print as extra lines
// that look like evidence.
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

const pct = (x: number | null | undefined) =>
  x === null || x === undefined ? "unknown" : `${Math.round(x * 100)}%`;

// MAT-002: every number in the score with the evidence behind it.
async function whyCommand(io: FitIo, jobId: string): Promise<number> {
  const fit = await io.fit.why(jobId);
  if (!fit) {
    io.print(`Job ${jobId} has no fit score yet. Run: jobs score`);
    return 1;
  }
  const e = fit.evidence as Evidence;
  const reason = fit.reason === "ok" ? "" : ` (${fit.reason})`;
  io.print(
    `Fit ${fit.score} · ${fit.band}${reason}${fit.stretch ? " · stretch" : ""} · preferences v${fit.preferenceVersion}`,
  );
  const c = fit.components;
  io.print(
    `  Title ${pct(c.title)} (${e.title.status}${e.title.levelMismatch ? ", level not in your seniority list" : ""})`,
  );
  io.print(`  Must-haves ${pct(c.mustHave)} · nice-to-haves ${pct(c.niceToHave)}`);
  io.print(
    `  Preferences ${pct(c.preference)} (pay ${e.pay.status}${e.pay.yearly === null ? "" : ` at ${e.pay.yearly}/year`}, place ${e.place.status})`,
  );
  if (e.dealbreaker !== null) io.print(`  Dealbreaker named: ${e.dealbreaker}`);
  const atoms = await io.fit.atomTexts([...new Set(e.matched.map((m) => m.atomId))]);
  for (const m of e.matched) {
    const atom = oneLine(atoms.get(m.atomId) ?? "?");
    io.print(`  ✓ ${oneLine(m.requirement)}  ← ${m.term}: ${atom} [atom ${m.atomId}]`);
  }
  for (const u of e.unmatched) {
    io.print(`  ✗ ${oneLine(u.requirement)}${u.kind === "nice" ? " (nice to have)" : ""}`);
  }
  return 0;
}
