import { type CandidateId, packageSha256, parsePackage } from "@northstar/domain";
import { and, eq } from "drizzle-orm";
import { applicationPackage } from "./application-package-schema.js";
import { approvalEdit, approvalRequest } from "./approval-schema.js";
import { type EditError, type EditResult, editRequest } from "./approval-write.js";
import type { Db } from "./db.js";
import { derivePackage, storePackage } from "./package-approval.js";
import { readPackageInputs } from "./package-read.js";

// A choice field's value must be one of the form's own options: editing one is a later slice.
const CHOICE_KINDS: ReadonlySet<string> = new Set(["select", "multi_select"]);

// Paul edits a waiting application package's answers before approving it (NS-203 slice 4,
// APR-002). Only the values of text fields the package already fills change, each to non-blank
// text (the package schema bounds it); the posting, contact, resume and cover letter stay. The
// Gate derives the edited package's facts again from storage (derivePackage) with no bank claims,
// so every field counts as `new` and no policy can approve the edit for Paul. In one transaction
// the old request is withdrawn by Paul, the new one is filed with the same subject, and the edited
// package is stored behind it. Errors never carry a field's value.
export async function editPackage(
  db: Db,
  input: { candidateId: CandidateId; requestId: string; fields: Readonly<Record<string, string>> },
): Promise<{ ok: true; value: EditResult } | { ok: false; error: EditError }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId)) {
    return { ok: false, error: { kind: "NotFound" } };
  }
  // A Map, so a field named like an Object property ("__proto__") stays data.
  const edits = new Map(Object.entries(input.fields));
  if (edits.size === 0) return { ok: false, error: { kind: "InvalidRequest", fields: ["fields"] } };
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const [row] = await scoped
      .select({ requestId: applicationPackage.requestId, package: applicationPackage.package })
      .from(applicationPackage)
      .where(
        and(
          eq(applicationPackage.candidateId, input.candidateId),
          eq(applicationPackage.requestId, input.requestId),
        ),
      );
    // No stored package behind it: nothing of the candidate's to edit here.
    if (!row) return { ok: false as const, error: { kind: "NotFound" as const } };
    const stored = parsePackage(row.package);
    if (!stored.ok) throw new Error("stored application package does not parse");
    const fields = new Map(Object.entries(stored.value.fields));
    // The stored form says which fields are choices; one on another ATS isn't this package's.
    const inputs = await readPackageInputs(scoped, input.candidateId, stored.value.applicationId);
    const form = inputs?.form?.ats === stored.value.ats ? inputs.form : null;
    const kinds = new Map(form?.questions.map((q) => [q.fieldName, q.kind]) ?? []);
    // Only a text field the package already fills, and only to text: a choice, a new field or a
    // blank answer isn't an edit this slice makes.
    const refused = [...edits]
      .filter(
        ([name, value]) =>
          typeof fields.get(name) !== "string" ||
          CHOICE_KINDS.has(kinds.get(name) ?? "") ||
          value.trim() === "",
      )
      .map(([name]) => `fields.${name}`);
    if (refused.length > 0) {
      return { ok: false as const, error: { kind: "InvalidRequest" as const, fields: refused } };
    }
    for (const [name, value] of edits) fields.set(name, value.replace(/\r\n/g, "\n"));
    const editedInput = { ...stored.value, fields: Object.fromEntries(fields) };
    // A repeat of an edit that already committed answers from the stored link first, so a newer
    // resume or contact saved meanwhile (which derivePackage would refuse) can't hide it.
    const [done] = await scoped
      .select({ requestId: approvalEdit.requestId, sha: approvalRequest.contentSha256 })
      .from(approvalEdit)
      .innerJoin(approvalRequest, eq(approvalRequest.id, approvalEdit.requestId))
      .where(eq(approvalEdit.previousRequestId, row.requestId));
    if (done) {
      const again = parsePackage(editedInput);
      if (!again.ok || packageSha256(again.value) !== done.sha) {
        return { ok: false as const, error: { kind: "NotPending" as const } };
      }
      const value = { requestId: done.requestId, previousRequestId: row.requestId, replayed: true };
      return { ok: true as const, value };
    }
    // No claims: every field of the edited package counts as `new` for the Gate's policy.
    const derived = await derivePackage(scoped, input.candidateId, editedInput, []);
    if (!derived.ok) {
      const invalid = derived.error.kind === "InvalidRequest" ? derived.error.fields : ["package"];
      return { ok: false as const, error: { kind: "InvalidRequest" as const, fields: invalid } };
    }
    const { pkg, sha, facts } = derived.value;
    const edited = await editRequest(scoped, {
      candidateId: input.candidateId,
      requestId: row.requestId,
      newContentSha256: sha,
      packageFacts: facts,
    });
    if (!edited.ok || edited.value.replayed) return edited;
    await storePackage(scoped, input.candidateId, edited.value.requestId, pkg);
    return edited;
  });
}

// One answer of a waiting package, as the Queue shows it (NS-203 slice 5).
export type PackageAnswer = {
  fieldName: string;
  // The stored form's own label for the field, or the field name when the form doesn't list it.
  label: string;
  // A list of picked choices is joined for reading; only text answers are editable.
  value: string;
  editable: boolean;
};

// The answers of the stored package behind one of the candidate's application_package requests,
// for Paul to read and edit in the Queue (NS-203 slice 5). Never the contact details, files or
// apply URL: only each filled field's label, value and whether editPackage would take an edit.
// Null when no package is stored behind the request.
export async function readPackageAnswers(
  db: Db,
  candidateId: CandidateId,
  requestId: string,
): Promise<PackageAnswer[] | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    return null;
  }
  const [row] = await db
    .select({ package: applicationPackage.package })
    .from(applicationPackage)
    .where(
      and(
        eq(applicationPackage.candidateId, candidateId),
        eq(applicationPackage.requestId, requestId),
      ),
    );
  if (!row) return null;
  const stored = parsePackage(row.package);
  if (!stored.ok) throw new Error("stored application package does not parse");
  // The job's current form, as editPackage reads it, so the two agree on what is editable. A form
  // the employer relabelled after filing shows its new label.
  const inputs = await readPackageInputs(db, candidateId, stored.value.applicationId);
  const form = inputs?.form?.ats === stored.value.ats ? inputs.form : null;
  const questions = new Map(form?.questions.map((q) => [q.fieldName, q]) ?? []);
  return Object.entries(stored.value.fields).map(([fieldName, value]) => {
    const question = questions.get(fieldName);
    return {
      fieldName,
      label: question?.label ?? fieldName,
      value: typeof value === "string" ? value : value.join(", "),
      // The same rule editPackage applies: text the package already holds, not a choice field.
      editable: typeof value === "string" && !CHOICE_KINDS.has(question?.kind ?? ""),
    };
  });
}
