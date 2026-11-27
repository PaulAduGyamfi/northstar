import type { CareerDnaStorePorts } from "./career-dna/store.js";
import { refreshCareerDna } from "./career-dna/store.js";

// `profile dna` (NS-130 slice 5, DNA-008): builds the Career DNA report from Paul's stored profile,
// saves it as a new version when it changed, and prints its lines and what changed. The lines are
// the rubric's fixed words and counts (labels, bands, evidence counts), never atom text.

export type DnaCliDeps = CareerDnaStorePorts & { print: (line: string) => void };

export const DNA_USAGE = "usage: profile dna";

export async function dnaCommand(deps: DnaCliDeps, args: string[]): Promise<number> {
  if (args.length > 0) {
    deps.print(DNA_USAGE);
    return 1;
  }
  const result = await refreshCareerDna(deps);
  if (!result.ok) {
    deps.print(
      result.error.kind === "NoProfile"
        ? "No Career DNA yet: import your resume first (profile import-resume <path>)."
        : "Not stored: the report didn't pass its checks. Nothing was changed.",
    );
    return 1;
  }
  const { report, stored, version, changes } = result.value;
  for (const line of report.lines) deps.print(line.text);
  deps.print(
    stored ? `Saved as version ${version}.` : `Unchanged since version ${version}; nothing stored.`,
  );
  deps.print("What changed:");
  for (const line of changes) deps.print(`  ${line}`);
  return 0;
}
