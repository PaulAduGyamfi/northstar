import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { applySubmission } from "./apply-schema.js";
import { candidate } from "./schema.js";

// Human handoffs (NS-121, APPLY-006, ACC-007). A submission the Apply Gateway stopped at a
// challenge (CAPTCHA, sign-in, MFA, account) becomes a handoff Paul finishes in his own browser
// (ADR-0003). Both tables are append-only (migration trigger); write them only through
// handoff-write.ts and recordNeedsHuman. The apply URL never goes into an event or span.

export const HANDOFF_OUTCOMES = ["submitted", "gave_up"] as const;
export type HandoffOutcome = (typeof HANDOFF_OUTCOMES)[number];

// One per challenged submission, written in the same transaction as its needs_human row.
export const applyHandoff = pgTable(
  "apply_handoff",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => applySubmission.id),
    // The page Paul opens: the package's apply URL, https only (no javascript: or data: links).
    applyUrl: text("apply_url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("apply_handoff_one_per_submission").on(t.submissionId),
    check("apply_handoff_url_https", sql`${t.applyUrl} ~ '^https://[^\\s]+$'`),
    check("apply_handoff_url_length", sql`length(${t.applyUrl}) <= 2048`),
  ],
);

// What Paul did, once per handoff.
export const applyHandoffDone = pgTable(
  "apply_handoff_done",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    handoffId: uuid("handoff_id")
      .notNull()
      .references(() => applyHandoff.id),
    outcome: text("outcome").notNull(),
    doneAt: timestamp("done_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("apply_handoff_done_once").on(t.handoffId),
    check("apply_handoff_done_outcome_valid", sql`${t.outcome} in ('submitted', 'gave_up')`),
  ],
);
