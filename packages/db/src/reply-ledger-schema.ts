import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { candidate } from "./schema.js";

// The Gmail draft writer's ledger (NS-237 slice 6, ADR-0025 item 5, RES-006): one approval makes
// one draft. Ids and times only, never a recipient, subject or body. Both tables are append-only
// (migration trigger) and written only through reply-ledger-write.ts.

// Each attempt to write the draft for one Gate decision. The newest attempt's age decides whether
// another run is still working (`in_progress`) or may have died mid-write (`unknown`).
export const replyDraftClaim = pgTable(
  "reply_draft_claim",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    // The Gate decision the writer acts under (verifyApproval checked it before the claim).
    decisionId: uuid("decision_id").notNull(),
    // 1 for the first claim, then one more for each claim taken after a lapsed lease.
    attempt: integer("attempt").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("reply_draft_claim_one_per_attempt").on(t.candidateId, t.decisionId, t.attempt),
    check("reply_draft_claim_attempt_range", sql`${t.attempt} between 1 and 100`),
  ],
);

// The draft a decision produced: at most one per decision, so a second record can't replace it.
export const replyDraftRecord = pgTable(
  "reply_draft_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    decisionId: uuid("decision_id").notNull(),
    // Gmail's id for the draft's message (hex), the one thing the writer keeps from Gmail.
    draftMessageId: text("draft_message_id").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("reply_draft_record_one_per_decision").on(t.candidateId, t.decisionId),
    check(
      "reply_draft_record_message_id_shape",
      sql`${t.draftMessageId} ~ '^[A-Za-z0-9_-]{1,64}$'`,
    ),
  ],
);
