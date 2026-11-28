import type { DuplicateSuggestionItem, SuggestedJob } from "@northstar/db";

// `jobs dupes` (NS-129 slice 3): the newest duplicate suggestions, each pair with both jobs'
// titles, companies and ids and how alike they are, for Paul to compare in his terminal. Nothing
// here merges, edits or deletes a job.

export type DupesCliDeps = { list: () => Promise<DuplicateSuggestionItem[]> };

export const DUPES_USAGE = "usage: jobs dupes";

// Returns null when the arguments aren't a `jobs dupes` command, so the caller prints its usage.
export async function dupesCommand(
  deps: DupesCliDeps & { print: (line: string) => void },
  argv: string[],
): Promise<number | null> {
  const [command, ...extra] = argv;
  if (command !== "dupes") return null;
  if (extra.length > 0) {
    deps.print(DUPES_USAGE);
    return 1;
  }
  const items = await deps.list();
  if (items.length === 0) {
    deps.print("No duplicate suggestions yet.");
    return 0;
  }
  deps.print(
    `${items.length} pair${items.length === 1 ? "" : "s"} that look like the same role (newest first):`,
  );
  for (const item of items) {
    const [a, b] = item.jobs;
    deps.print(`${Math.round(item.similarity * 100)}% alike`);
    deps.print(`  ${describe(a)}`);
    deps.print(`  ${describe(b)}`);
  }
  deps.print("Nothing was merged. Compare them with jobs why <job-id>.");
  return 0;
}

const describe = (j: SuggestedJob) =>
  `${j.title ?? "(no title)"} at ${j.company ?? "(no company)"} (${j.jobId})`;
