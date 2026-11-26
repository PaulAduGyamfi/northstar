import type { TailorRun } from "./tailor/run.js";

// `profile tailor <job-id> [--drop <skill,skill>]` (NS-146, TLR-003): the diff against the master,
// what the resume doesn't claim, the pre-send score and the validator result. Paul only: it
// prints his real profile back to him.

export type TailorCliDeps = {
  print: (line: string) => void;
  runTailor: (jobId: string, drop: string[]) => Promise<TailorRun>;
};

const REFUSED: Record<string, string> = {
  NoProfile: "No resume imported yet. Run: profile import-resume data/<file>",
  JobNotFound: "No job with that id. Run: jobs list",
  JobNotReady: "That job is a draft: give it a title and company first (jobs set).",
};

export async function tailorCommand(
  deps: TailorCliDeps,
  jobId: string,
  drop: string[],
): Promise<number> {
  const run = await deps.runTailor(jobId, drop);
  if (run.kind === "refused") {
    deps.print(REFUSED[run.reason] ?? run.reason);
    return 1;
  }
  if (run.kind === "bad_toggle") {
    deps.print(
      `Not tailored: only skills the tailor added can be turned off (${run.names.join(", ")}).`,
    );
    return 1;
  }
  const what = new Map(run.master.atoms.map((a) => [a.id, a.what]));
  const changed = run.diff.atoms.filter((a) => a.status !== "kept" || a.reworded);
  deps.print(
    `Lines: ${run.diff.atoms.filter((a) => a.status !== "dropped").length} of ${run.diff.atoms.length} atoms, ${run.pages} page${run.pages === 1 ? "" : "s"}`,
  );
  for (const a of changed)
    deps.print(`  ${a.status}${a.reworded ? ", reworded" : ""}: ${what.get(a.atomId) ?? a.atomId}`);
  for (const s of run.diff.skills.filter((x) => x.status !== "kept"))
    deps.print(`  skill ${s.status}: ${s.name}`);
  if (run.resume.notClaimed.length > 0)
    deps.print(`Not claimed: ${run.resume.notClaimed.join("; ")}`);
  const { title, keywords, ats } = run.score;
  deps.print(
    `Pre-send: title ${title}, keywords ${keywords.covered}/${keywords.total}, ATS re-parse ${ats.pass ? "pass" : "fail"} (${Math.round(ats.recovered * 100)}%)`,
  );
  if (keywords.missing.length > 0) deps.print(`Missing keywords: ${keywords.missing.join(", ")}`);
  if (run.validation.ok) deps.print("Every line cites an atom.");
  else for (const f of run.validation.failures) deps.print(`Problem: ${f.item}: ${f.problem}`);
  deps.print(
    run.saved ? `Saved as version ${run.version}.` : `Unchanged since version ${run.version}.`,
  );
  return run.validation.ok ? 0 : 1;
}

// `--drop a,b` → ["a", "b"]; undefined when the flag is malformed.
export function parseDrop(flags: string[]): string[] | undefined {
  if (flags.length === 0) return [];
  if (flags.length !== 2 || flags[0] !== "--drop" || !flags[1]) return undefined;
  const names = flags[1]
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  return names.length > 0 ? names : undefined;
}
