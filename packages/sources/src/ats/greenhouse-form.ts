import type { JobFormQuestion } from "@northstar/db";
import { z } from "zod";
import { type FetchDeps, safeFetch } from "../fetch.js";
import { safeJson } from "./greenhouse.js";

// A Greenhouse posting's application questions (NS-227, APPLY-001), from the public job-board API
// with `?questions=true`: the same JSON its hosted application form is built from. Only
// `questions` is read: location, compliance and voluntary demographic questions are left out.
// Labels and choices are the employer's text: they are stored and compared by plain code only.

const GreenhouseField = z.object({
  name: z.string().min(1),
  type: z.string(),
  values: z
    .array(z.object({ label: z.string(), value: z.union([z.number(), z.string()]) }))
    .optional(),
});

const GreenhouseForm = z.object({
  questions: z.array(
    z.object({
      required: z.boolean(),
      label: z.string(),
      fields: z.array(GreenhouseField),
    }),
  ),
});

// Greenhouse's field types and what each one is. Anything else makes the form unreadable.
const KINDS: Record<string, JobFormQuestion["kind"]> = {
  input_text: "text",
  textarea: "textarea",
  multi_value_single_select: "select",
  multi_value_multi_select: "multi_select",
  input_file: "file",
  input_hidden: "hidden",
};

// The posting's form, or null when the API didn't answer 200, the answer isn't a form, or a field
// type is one we don't know (a guess would fill the form wrong).
export async function readGreenhouseForm(
  deps: FetchDeps,
  t: { board: string; postingId: string },
): Promise<JobFormQuestion[] | null> {
  const read = await readGreenhouseFormResult(deps, t);
  return read.kind === "form" ? read.questions : null;
}

// The same read, telling apart Greenhouse failing for now (429 or 5xx: worth a retry, and it
// counts against the breaker) from an answer that is no readable form (NS-280 slice 2).
export type GreenhouseFormRead =
  | { kind: "form"; questions: JobFormQuestion[] }
  | { kind: "unavailable"; status: number }
  | { kind: "unreadable" };

export async function readGreenhouseFormResult(
  deps: FetchDeps,
  t: { board: string; postingId: string },
): Promise<GreenhouseFormRead> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t.board)}/jobs/${encodeURIComponent(t.postingId)}?questions=true`;
  const res = await safeFetch(deps, url);
  if (res.status === 429 || res.status >= 500) return { kind: "unavailable", status: res.status };
  if (res.status !== 200) return { kind: "unreadable" };
  const parsed = GreenhouseForm.safeParse(safeJson(res.body));
  if (!parsed.success) return { kind: "unreadable" };
  const out: JobFormQuestion[] = [];
  for (const [group, q] of parsed.data.questions.entries()) {
    for (const f of q.fields) {
      // Own keys only: a type such as "constructor" must not find Object's built-ins.
      const kind = Object.hasOwn(KINDS, f.type) ? KINDS[f.type] : undefined;
      if (kind === undefined) return { kind: "unreadable" };
      const select = kind === "select" || kind === "multi_select";
      out.push({
        fieldName: f.name,
        label: q.label,
        required: q.required,
        kind,
        choices: select
          ? (f.values ?? []).map((v) => ({ label: v.label, value: String(v.value) }))
          : null,
        group,
      });
    }
  }
  return { kind: "form", questions: out };
}
