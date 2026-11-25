import { type ApplicationPackage, err, ok, type Result } from "@northstar/domain";
import type { AtsAdapter } from "./adapters/adapter.js";
import type { Fill, FormField } from "./driver.js";

export type FilePlan = { field: string; kind: "resume" | "coverLetter" };
export type FieldPlan = { fills: Fill[]; files: FilePlan[] };
export type MapError = { kind: "unmapped_required" | "form_changed"; fields: string[] };

// Maps a package onto the form the page shows (APPLY-002), before anything is typed. Every value
// must land on a field the form has (otherwise the form changed since the package was built),
// a choice must be one of the field's options, and every required field must get a value.
export function mapPackage(
  adapter: AtsAdapter,
  form: readonly FormField[],
  pkg: ApplicationPackage,
): Result<FieldPlan, MapError> {
  const byName = new Map(form.map((f) => [f.name, f]));
  const standard = adapter.standardFields(pkg.contact);
  const values: Record<string, string | readonly string[]> = { ...standard };
  const changed: string[] = [];
  for (const [name, value] of Object.entries(pkg.fields)) {
    // The field map never overrides a standard field: those come from the contact block only.
    if (name in standard || name === adapter.resumeField || name === adapter.coverLetterField) {
      changed.push(name);
      continue;
    }
    values[name] = value;
  }
  const fills: Fill[] = [];
  for (const [name, value] of Object.entries(values)) {
    const field = byName.get(name);
    if (!field || field.type === "file" || field.type === "hidden" || !optionsAllow(field, value)) {
      changed.push(name);
      continue;
    }
    fills.push({ field: name, value });
  }
  const files: FilePlan[] = [{ field: adapter.resumeField, kind: "resume" }];
  if (pkg.coverLetter !== null) {
    if (adapter.coverLetterField === null) changed.push("coverLetter");
    else files.push({ field: adapter.coverLetterField, kind: "coverLetter" });
  }
  for (const file of files) {
    if (byName.get(file.field)?.type !== "file") changed.push(file.field);
  }
  if (changed.length > 0) return err({ kind: "form_changed", fields: changed.sort() });
  const given = new Set([...fills.map((f) => f.field), ...files.map((f) => f.field)]);
  const missing = form
    .filter((f) => f.required && f.type !== "hidden" && !given.has(f.name))
    .map((f) => f.name);
  if (missing.length > 0) return err({ kind: "unmapped_required", fields: missing.sort() });
  return ok({ fills, files });
}

// A choice field only takes values from its own options; free-text fields take one string.
function optionsAllow(field: FormField, value: string | readonly string[]): boolean {
  const list = typeof value === "string" ? [value] : value;
  if (field.type === "checkbox") {
    return field.options === undefined || list.every((v) => field.options?.includes(v));
  }
  if (typeof value !== "string") return false;
  if (field.type === "select" || field.type === "radio") {
    return field.options === undefined || field.options.includes(value);
  }
  return true;
}
