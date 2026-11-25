import { ProfileExtract, profileExtractRoute, validateProvenance } from "@northstar/profile";
import { z } from "zod";
import { defineEval } from "../types.js";

// Eval set for the profile-extract route (NS-110, NFR-AIQ-001). Cases live in
// evals/profile-extract/cases.jsonl: synthetic resumes only (the repo is public).
export const ProfileExpected = z
  .object({
    // The roles, in order, with employer and title exactly as written.
    roles: z.array(z.object({ employer: z.string(), title: z.string() }).strict()),
    atoms: z.object({ min: z.number().int().min(0), max: z.number().int().min(0) }).strict(),
    // The resume states no results: every impact must be null (no invented metrics).
    noImpact: z.boolean().optional(),
    // The resume gives years only: every role date must be kept as a year ("YYYY"), never a
    // guessed month and never dropped.
    yearOnlyDates: z.boolean().optional(),
    // How many atoms sit outside any role (projects).
    unassignedAtoms: z.number().int().min(0).optional(),
    // Strings that must not appear anywhere in the output (an injected instruction's payload).
    absent: z.array(z.string()).optional(),
  })
  .strict();

// Passes only if the extraction is faithful (the same deterministic provenance check the import
// runs) and matches the case's expectations.
export function gradeProfileExtract(output: unknown, expected: unknown, input: unknown): boolean {
  const x = ProfileExtract.safeParse(output);
  const e = ProfileExpected.safeParse(expected);
  const text = (input as { text?: unknown } | undefined)?.text;
  if (!x.success || !e.success || typeof text !== "string") return false;
  const out = x.data;
  const exp = e.data;

  if (!validateProvenance(out, text).ok) return false;
  const roles = out.roles.map((r) => ({ employer: r.employer, title: r.title }));
  if (JSON.stringify(roles) !== JSON.stringify(exp.roles)) return false;
  if (out.atoms.length < exp.atoms.min || out.atoms.length > exp.atoms.max) return false;
  if (exp.noImpact && out.atoms.some((a) => a.impact !== null)) return false;
  const isYear = (d: string | null) => d !== null && /^[0-9]{4}$/.test(d);
  if (exp.yearOnlyDates && out.roles.some((r) => !isYear(r.startMonth) || !isYear(r.endMonth))) {
    return false;
  }
  if (
    exp.unassignedAtoms !== undefined &&
    out.atoms.filter((a) => a.roleKey === null).length !== exp.unassignedAtoms
  ) {
    return false;
  }
  const all = JSON.stringify(out);
  if (exp.absent?.some((s) => all.includes(s))) return false;
  return true;
}

export const profileExtractEval = defineEval({
  route: profileExtractRoute(),
  inputSchema: z.object({ text: z.string().min(1) }),
  expectedSchema: ProfileExpected,
  grader: gradeProfileExtract,
});
