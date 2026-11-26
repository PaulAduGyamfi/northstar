import type { JobFormQuestion, SaveJobFormResult } from "@northstar/db";
import { detectAts } from "./ats/detect.js";

// `jobs form <job-id>` (NS-227, APPLY-001): read a saved job's application form from its ATS's
// public API and store it with the job. Only Greenhouse publishes its questions; Lever's and
// Ashby's forms wait for the browser driver (NS-142). Prints counts and the required questions'
// labels (the employer's own words, shown back to Paul in his terminal).

export type FormCliDeps = {
  sources: (jobId: string) => Promise<{ ats: string | null; url: string }[]>;
  readGreenhouse: (t: { board: string; postingId: string }) => Promise<JobFormQuestion[] | null>;
  save: (jobId: string, questions: JobFormQuestion[]) => Promise<SaveJobFormResult>;
};

export const FORM_USAGE = "usage: jobs form <job-id>";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const REFUSED: Record<"too_many_fields" | "text_too_long" | "too_many_choices", string> = {
  too_many_fields: "it has more than 200 fields",
  text_too_long: "a label, field name or choice is longer than 1,000 characters",
  too_many_choices: "a question has more than 500 choices",
};

// Returns null when the arguments aren't a `jobs form` command, so the caller prints its usage.
export async function formCommand(
  deps: FormCliDeps & { print: (line: string) => void },
  argv: string[],
): Promise<number | null> {
  const [command, jobId, ...rest] = argv;
  if (command !== "form") return null;
  if (!jobId || rest.length > 0) {
    deps.print(FORM_USAGE);
    return 1;
  }
  // The first Greenhouse source whose link names its board and posting.
  const target = (await deps.sources(jobId))
    .map((s) => detectAts(s.url))
    .find((t) => t?.ats === "greenhouse");
  if (target?.ats !== "greenhouse") {
    deps.print(
      `Job ${jobId} has no Greenhouse link. Only Greenhouse publishes its application questions; other forms wait for the browser driver.`,
    );
    return 1;
  }
  const questions = await deps.readGreenhouse({ board: target.board, postingId: target.postingId });
  if (questions === null) {
    deps.print(
      "Couldn't read the form: Greenhouse didn't answer, or the form has a field type Northstar doesn't know. Nothing stored.",
    );
    return 1;
  }
  const saved = await deps.save(jobId, questions);
  if (saved.status === "refused") {
    deps.print(`Not stored: ${REFUSED[saved.reason]}.`);
    return 1;
  }
  const groups = new Set(questions.map((q) => q.group)).size;
  deps.print(
    saved.status === "stored"
      ? `Stored job ${jobId}'s form: ${plural(groups, "question")}, ${plural(questions.length, "field")}.`
      : `Job ${jobId}'s form is unchanged: ${plural(groups, "question")}, ${plural(questions.length, "field")}.`,
  );
  // One label per required question, in form order (a group's fields share its label).
  const required = [
    ...new Map(questions.filter((q) => q.required).map((q) => [q.group, q.label])).values(),
  ];
  if (required.length > 0) deps.print(`Required: ${required.join("; ")}`);
  return 0;
}
