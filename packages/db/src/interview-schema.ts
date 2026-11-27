import { INTERVIEW_FORMATS } from "@northstar/domain";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { application, candidate } from "./schema.js";

// The fixed format list as SQL literals, for the CHECK: constants only, never input.
const FORMAT_LIST = sql.raw(INTERVIEW_FORMATS.map((f) => `'${f}'`).join(", "));

// A detected interview (NS-240 slice 2, CAL-002): a calendar event plain code matched to one of
// Paul's applications. An invite isn't authenticated, so it waits for Paul's decision and never
// moves a status. Times, the format and a count only: never the title, description, an address
// or a name. A rescheduled event is a new version; the highest version per event and application is
// current. Anyone can send Paul an invite, so versions are capped (MAX_DETECTION_VERSIONS).
// Append-only (migration trigger), written only through interview-write.ts.
export const interviewDetection = pgTable(
  "interview_detection",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    applicationId: uuid("application_id").notNull(),
    // Google's event id (base32hex, or an instance id with `_<time>`).
    calendarEventId: text("calendar_event_id").notNull(),
    format: text("format").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    interviewerCount: integer("interviewer_count").notNull(),
    // 1 for the first detection of an event for this application, then one more per time change.
    version: integer("version").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The application must be the candidate's own.
    foreignKey({
      name: "interview_detection_application_same_candidate_fk",
      columns: [t.applicationId, t.candidateId],
      foreignColumns: [application.id, application.candidateId],
    }),
    // One row per version: two writers racing for the same version can't both store it.
    unique("interview_detection_version_once").on(
      t.candidateId,
      t.calendarEventId,
      t.applicationId,
      t.version,
    ),
    check("interview_detection_version_range", sql`${t.version} between 1 and 10`),
    check(
      "interview_detection_event_id_shape",
      sql`${t.calendarEventId} ~ '^[A-Za-z0-9_]{1,200}$'`,
    ),
    check("interview_detection_format_listed", sql`${t.format} in (${FORMAT_LIST})`),
    check("interview_detection_ends_after_start", sql`${t.endsAt} > ${t.startsAt}`),
    check("interview_detection_interviewers_range", sql`${t.interviewerCount} between 0 and 50`),
  ],
);

// Paul's decision on one detection (NS-240 slice 2): confirmed or dismissed, once. Append-only.
// The detection is checked in the same transaction, not by a foreign key: one would make TRUNCATE
// on the append-only interview_detection fail with Postgres's foreign-key error before its
// trigger's refusal (as recruiter_grade does for mail_link).
export const interviewDecision = pgTable(
  "interview_decision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    detectionId: uuid("detection_id").notNull(),
    decision: text("decision").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("interview_decision_once").on(t.detectionId),
    check("interview_decision_valid", sql`${t.decision} in ('confirmed', 'dismissed')`),
  ],
);

// The prep Northstar proposes for one confirmed interview (NS-241 slice 1, CAL-003): one row per
// detection, with what the planner couldn't place. Proposals only: nothing reaches the calendar
// without Paul's approval (ADR-0002, a later slice). The detection is checked in the transaction,
// not by a foreign key, as interview_decision does. Append-only (migration trigger), written only
// through interview-prep-write.ts.
export const interviewPrepProposal = pgTable(
  "interview_prep_proposal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    detectionId: uuid("detection_id").notNull(),
    // How many of the default prep blocks couldn't be placed (0–2), and whether the warm-up couldn't.
    missingPrep: integer("missing_prep").notNull(),
    warmUpMissing: boolean("warm_up_missing").notNull(),
    proposedAt: timestamp("proposed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("interview_prep_proposal_once").on(t.detectionId),
    // The composite target for the blocks' same-candidate foreign key.
    unique("interview_prep_proposal_id_candidate_unique").on(t.id, t.candidateId),
    check("interview_prep_proposal_missing_range", sql`${t.missingPrep} between 0 and 2`),
  ],
);

// One proposed block of a proposal: a prep block or the warm-up, by time only. Append-only.
export const interviewPrepBlock = pgTable(
  "interview_prep_block",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    proposalId: uuid("proposal_id").notNull(),
    kind: text("kind").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    // The proposal must be the candidate's own.
    foreignKey({
      name: "interview_prep_block_proposal_same_candidate_fk",
      columns: [t.proposalId, t.candidateId],
      foreignColumns: [interviewPrepProposal.id, interviewPrepProposal.candidateId],
    }),
    // A block starts once per proposal: a replayed insert can't double a block.
    unique("interview_prep_block_once").on(t.proposalId, t.startsAt),
    check("interview_prep_block_kind_listed", sql`${t.kind} in ('prep', 'warm_up')`),
    check("interview_prep_block_ends_after_start", sql`${t.endsAt} > ${t.startsAt}`),
  ],
);
