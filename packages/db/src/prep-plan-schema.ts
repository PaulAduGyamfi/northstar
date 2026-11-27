import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { approvalRequest } from "./approval-schema.js";
import { interviewPrepProposal } from "./interview-schema.js";
import { candidate } from "./schema.js";

// Prep plans through the Approval Gate and the Calendar writer's ledger (NS-241 slice 4,
// ADR-0031 items 3 and 5). Ids, versions, counts and times only: never a title, time zone,
// company or name. Every table is append-only (migration trigger) and written only through
// prep-plan-write.ts and prep-ledger-write.ts.

// One row per `prep_plan` Gate request, filed from a stored proposal only. The composite foreign
// key pins the request's id, candidate, kind and content hash, as reply_draft's does, so a
// request someone else files for the same subject can never be written.
export const prepPlanRequest = pgTable(
  "prep_plan_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    requestId: uuid("request_id").notNull(),
    // Always prep_plan: with content_sha256 it joins the foreign key.
    requestKind: text("request_kind").notNull().default("prep_plan"),
    proposalId: uuid("proposal_id").notNull(),
    // The detection the plan was filed for: its row id and version, both in the hash.
    detectionId: uuid("detection_id").notNull(),
    detectionVersion: integer("detection_version").notNull(),
    // prepPlanContentSha256 (packages/domain): the hash the Gate request pins.
    contentSha256: text("content_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("prep_plan_request_request_unique").on(t.requestId),
    // One plan per proposal (ADR-0031 item 3: rounds after a rejection are a later slice).
    unique("prep_plan_request_proposal_unique").on(t.proposalId),
    foreignKey({
      name: "prep_plan_request_request_same_candidate_fk",
      columns: [t.requestId, t.candidateId, t.requestKind, t.contentSha256],
      foreignColumns: [
        approvalRequest.id,
        approvalRequest.candidateId,
        approvalRequest.kind,
        approvalRequest.contentSha256,
      ],
    }),
    // The proposal must be the candidate's own.
    foreignKey({
      name: "prep_plan_request_proposal_same_candidate_fk",
      columns: [t.proposalId, t.candidateId],
      foreignColumns: [interviewPrepProposal.id, interviewPrepProposal.candidateId],
    }),
    check("prep_plan_request_kind", sql`${t.requestKind} = 'prep_plan'`),
    check("prep_plan_request_version_range", sql`${t.detectionVersion} between 1 and 10`),
    check("prep_plan_request_sha256_shape", sql`${t.contentSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

// Each attempt to write one decision's plan. The newest attempt's age decides whether another run
// is still working (`in_progress`) or may have died mid-write (`unknown`).
export const prepWriteClaim = pgTable(
  "prep_write_claim",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    // The Gate decision the writer acts under (verifyApproval checked it before the claim).
    decisionId: uuid("decision_id").notNull(),
    attempt: integer("attempt").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("prep_write_claim_one_per_attempt").on(t.candidateId, t.decisionId, t.attempt),
    check("prep_write_claim_attempt_range", sql`${t.attempt} between 1 and 100`),
  ],
);

// The write a decision produced: at most one per decision. The event ids are derived from the
// decision (prepEventId), so the count is all that needs keeping.
export const prepWriteRecord = pgTable(
  "prep_write_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    decisionId: uuid("decision_id").notNull(),
    proposalId: uuid("proposal_id").notNull(),
    blockCount: integer("block_count").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("prep_write_record_one_per_decision").on(t.candidateId, t.decisionId),
    check("prep_write_record_block_count_range", sql`${t.blockCount} between 1 and 10`),
  ],
);

// The Northstar calendar's id (CAL-001): the candidate's, not one decision's, stored once.
export const northstarCalendar = pgTable(
  "northstar_calendar",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    // A secondary calendar's id as calendars.insert makes it (the writer's own CALENDAR_ID rule).
    calendarId: text("calendar_id").notNull(),
    savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("northstar_calendar_one_per_candidate").on(t.candidateId),
    check(
      "northstar_calendar_id_shape",
      sql`${t.calendarId} ~ '^[a-z0-9_]{1,128}@group[.]calendar[.]google[.]com$'`,
    ),
  ],
);
