import { INTERVIEW_FORMATS } from "@northstar/domain";
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
import { application, candidate } from "./schema.js";

// The fixed format list as SQL literals, for the CHECK: constants only, never input.
const FORMAT_LIST = sql.raw(INTERVIEW_FORMATS.map((f) => `'${f}'`).join(", "));

// A detected interview (NS-240 slice 2, CAL-002): a calendar event plain code matched to one of
// Paul's applications. An invite isn't authenticated, so it waits for Paul's decision and never
// moves a status. Times, the format and a count only: never the title, description, an address
// or a name. A rescheduled event is a new row; the newest row per event and application is current.
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
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The application must be the candidate's own.
    foreignKey({
      name: "interview_detection_application_same_candidate_fk",
      columns: [t.applicationId, t.candidateId],
      foreignColumns: [application.id, application.candidateId],
    }),
    // The same detection twice stores nothing; a moved event stores a new row.
    unique("interview_detection_once").on(
      t.candidateId,
      t.calendarEventId,
      t.applicationId,
      t.startsAt,
      t.endsAt,
    ),
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
