import {
  type ApplicationPackage,
  type CandidateId,
  err,
  ok,
  packageSha256,
  packageSubject,
  parsePackage,
  type Result,
} from "@northstar/domain";
import { and, eq } from "drizzle-orm";
import { applicationPackage } from "./application-package-schema.js";
import { applySubmission } from "./apply-schema.js";
import { inSpan } from "./apply-write.js";
import { approvalDecision } from "./approval-schema.js";
import { verifyApproval } from "./approval-write.js";
import type { Db } from "./db.js";
import { applyHandoff, applyHandoffDone } from "./handoff-schema.js";

// The approved package behind one open handoff (NS-192, APPLY-006), for the extension's pre-fill
// in Paul's own tab. Read-only. Everything is checked here, on the server, at the moment of the
// read: the handoff is the candidate's and still open, the approval behind its submission still
// verifies, and the stored package still hashes to what the Gate pinned. Field values go back to
// the caller only: never into a span, an event or an error.

export type HandoffPackage = {
  handoffId: string;
  applicationId: string;
  ats: ApplicationPackage["ats"];
  applyUrl: string;
  contact: ApplicationPackage["contact"];
  fields: ApplicationPackage["fields"];
};

export type HandoffPackageError =
  // No such handoff for this candidate: another candidate's reads the same as a missing one.
  | { kind: "NotFound" }
  // Paul already said "I submitted it" or "I gave up".
  | { kind: "Closed" }
  // Filed before packages were stored (NS-192): there is nothing to fill from.
  | { kind: "NoPackage" }
  // The approval no longer verifies (rejected, undone, withdrawn, …): its reason code only.
  | { kind: "NotApproved"; reason: string }
  // The stored package no longer hashes to the content the Gate pinned.
  | { kind: "Changed" };

export async function readHandoffPackage(
  db: Db,
  candidateId: CandidateId,
  handoffId: string,
): Promise<Result<HandoffPackage, HandoffPackageError>> {
  // inSpan records the outcome (the kind only), never a value.
  return inSpan("db.apply.handoff_package", {}, () => read(db, candidateId, handoffId));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function read(
  db: Db,
  candidateId: CandidateId,
  handoffId: string,
): Promise<Result<HandoffPackage, HandoffPackageError>> {
  if (!UUID.test(handoffId)) return err({ kind: "NotFound" });
  const [h] = await db
    .select({
      handoffId: applyHandoff.id,
      applyUrl: applyHandoff.applyUrl,
      applicationId: applySubmission.applicationId,
      decisionId: applySubmission.decisionId,
      done: applyHandoffDone.id,
    })
    .from(applyHandoff)
    .innerJoin(applySubmission, eq(applySubmission.id, applyHandoff.submissionId))
    .leftJoin(applyHandoffDone, eq(applyHandoffDone.handoffId, applyHandoff.id))
    .where(and(eq(applyHandoff.id, handoffId), eq(applyHandoff.candidateId, candidateId)));
  if (!h) return err({ kind: "NotFound" });
  if (h.done !== null) return err({ kind: "Closed" });

  // The package stored behind the request this submission's decision approved.
  const [row] = await db
    .select({
      contentSha256: applicationPackage.contentSha256,
      package: applicationPackage.package,
    })
    .from(approvalDecision)
    .innerJoin(applicationPackage, eq(applicationPackage.requestId, approvalDecision.requestId))
    .where(
      and(
        eq(approvalDecision.id, h.decisionId),
        eq(approvalDecision.candidateId, candidateId),
        eq(applicationPackage.candidateId, candidateId),
      ),
    );
  if (!row) return err({ kind: "NoPackage" });
  const parsed = parsePackage(row.package);
  // A package that no longer parses, or hashes to anything but what the Gate pinned, isn't the
  // package Paul approved.
  if (!parsed.ok || packageSha256(parsed.value) !== row.contentSha256) {
    return err({ kind: "Changed" });
  }
  const pkg = parsed.value;
  // The package must be the one this handoff's submission was for.
  if (pkg.applicationId !== h.applicationId) return err({ kind: "Changed" });

  // The approval still stands now, for exactly this content (ADR-0002: checked at the moment of
  // use, never trusted from earlier).
  const verified = await verifyApproval(db, {
    candidateId,
    decisionId: h.decisionId,
    kind: "application_package",
    subject: packageSubject(pkg),
    contentSha256: row.contentSha256,
  });
  if (!verified.ok) return err({ kind: "NotApproved", reason: verified.error.kind });

  return ok({
    handoffId: h.handoffId,
    applicationId: h.applicationId,
    ats: pkg.ats,
    applyUrl: h.applyUrl,
    contact: pkg.contact,
    fields: pkg.fields,
  });
}
