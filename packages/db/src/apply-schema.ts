import { APPLY_ATS, NEEDS_HUMAN_REASONS } from "@northstar/domain";
import { sql } from "drizzle-orm";
import {
  check,
  customType,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { approvalDecision } from "./approval-schema.js";
import { application, candidate } from "./schema.js";

// The Apply Gateway's ledger (NS-120, APPLY-007/008/009). Write it only through apply-write.ts.
// Times come from the database clock (northstar_gate_now(), the Approval Gate's), never a caller.

// Constants from @northstar/domain, so sql.raw builds no SQL from input.
const atsList = sql.raw(APPLY_ATS.map((a) => `'${a}'`).join(", "));
const reasonList = sql.raw(NEEDS_HUMAN_REASONS.map((r) => `'${r}'`).join(", "));

export const SUBMISSION_STATUSES = ["in_progress", "submitted", "needs_human"] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

// One attempt to submit one application. Claimed before the browser does anything, so a crash
// leaves an in_progress row that is never retried blindly. A trigger (migration 0021) lets only
// an in_progress row change, once, to submitted or needs_human, and refuses deletes.
export const applySubmission = pgTable(
  "apply_submission",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => application.id),
    // The Gate decision that authorized it (ADR-0002 item 3, APR-004).
    decisionId: uuid("decision_id")
      .notNull()
      .references(() => approvalDecision.id),
    ats: text("ats").notNull(),
    // `<ats>:<postingId>`: the requisition (APPLY-009).
    requisitionKey: text("requisition_key").notNull(),
    // `application:<id>:submit` (RES-006).
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull(),
    // Set only when status is needs_human: a code from NEEDS_HUMAN_REASONS.
    reason: text("reason"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    unique("apply_submission_idempotency_unique").on(t.candidateId, t.idempotencyKey),
    // Never the same requisition twice, whatever source or job it came through (APPLY-009).
    unique("apply_submission_requisition_unique").on(t.candidateId, t.requisitionKey),
    unique("apply_submission_application_unique").on(t.candidateId, t.applicationId),
    // One submission at a time per ATS (APPLY-007).
    uniqueIndex("apply_submission_one_in_progress_per_ats")
      .on(t.candidateId, t.ats)
      .where(sql`${t.status} = 'in_progress'`),
    check("apply_submission_ats_valid", sql`${t.ats} in (${atsList})`),
    check(
      "apply_submission_status_valid",
      sql`${t.status} in ('in_progress', 'submitted', 'needs_human')`,
    ),
    check(
      "apply_submission_reason_valid",
      sql`(${t.status} = 'needs_human' and ${t.reason} in (${reasonList}))
        or (${t.status} <> 'needs_human' and ${t.reason} is null)`,
    ),
    check(
      "apply_submission_finished",
      sql`(${t.status} = 'in_progress') = (${t.finishedAt} is null)`,
    ),
  ],
);

// Proof of submission (APPLY-008): the confirmation page as HTML and a screenshot, what was sent
// and with which resume. Append-only (migration 0021). It holds personal data (the field values),
// so it never leaves the database: events and spans carry its id and hashes only.
export const submissionProof = pgTable(
  "submission_proof",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => applySubmission.id),
    confirmationHtml: text("confirmation_html").notNull(),
    htmlSha256: text("html_sha256").notNull(),
    screenshotPng: bytea("screenshot_png").notNull(),
    screenshotSha256: text("screenshot_sha256").notNull(),
    // Exactly what was typed or chosen, by form field name.
    fieldValues: jsonb("field_values").$type<Record<string, string | string[]>>().notNull(),
    resumeSha256: text("resume_sha256").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("submission_proof_one_per_submission").on(t.submissionId),
    check("submission_proof_html_sha256_format", sql`${t.htmlSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "submission_proof_screenshot_sha256_format",
      sql`${t.screenshotSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check("submission_proof_resume_sha256_format", sql`${t.resumeSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);
