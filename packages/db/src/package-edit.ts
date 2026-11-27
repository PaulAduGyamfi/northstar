import { type CandidateId, parsePackage } from "@northstar/domain";
import { and, eq } from "drizzle-orm";
import { applicationPackage } from "./application-package-schema.js";
import { type EditError, type EditResult, editRequest } from "./approval-write.js";
import type { Db } from "./db.js";
import { derivePackage, storePackage } from "./package-approval.js";

// Paul edits a waiting application package's answers before approving it (NS-203 slice 4,
// APR-002). Only the values of fields the package already fills change, each to one line of text
// where it held text: the posting, contact details, resume and cover letter stay as filed. The
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
    // Only a field the package already fills with text, and only to text: a picked list of
    // choices, a new field or a blank answer isn't an edit this slice makes.
    const refused = [...edits]
      .filter(([name, value]) => typeof fields.get(name) !== "string" || value.trim() === "")
      .map(([name]) => `fields.${name}`);
    if (refused.length > 0) {
      return { ok: false as const, error: { kind: "InvalidRequest" as const, fields: refused } };
    }
    for (const [name, value] of edits) fields.set(name, value.replace(/\r\n/g, "\n"));
    // No claims: every field of the edited package counts as `new` for the Gate's policy.
    const derived = await derivePackage(
      scoped,
      input.candidateId,
      { ...stored.value, fields: Object.fromEntries(fields) },
      [],
    );
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
    await storePackage(scoped, input.candidateId, edited.value.requestId, pkg, sha);
    return edited;
  });
}
