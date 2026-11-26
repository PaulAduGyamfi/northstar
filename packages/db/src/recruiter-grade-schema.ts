import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { candidate } from "./schema.js";

// A recruiter message's A–F grade (NS-238, REC-001/002): one per recorded Gmail message, decided by
// plain code (gradeRecruiterMessage in @northstar/sources). Codes and numbers only, never email
// text. Append-only (migration trigger), written only through recruiter-grade-write.ts.
export const recruiterGrade = pgTable(
  "recruiter_grade",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    gmailMessageId: text("gmail_message_id").notNull(),
    grade: text("grade").notNull(),
    points: integer("points").notNull(),
    // `<factor>:<outcome>` codes, or `dealbreaker` (GradeReason in @northstar/sources).
    reasons: text("reasons").array().notNull(),
    confidence: text("confidence").notNull(),
    gradedAt: timestamp("graded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One grade per message: a regrade (REC-003) comes later, with Paul's actions.
    unique("recruiter_grade_one_per_message").on(t.candidateId, t.gmailMessageId),
    // Only a message the mail loop recorded can be graded: recordRecruiterGrade checks its mail_link
    // in the same transaction. Not a foreign key: one would make TRUNCATE on the append-only
    // mail_link fail with Postgres's foreign-key error before its own trigger's refusal.
    check("recruiter_grade_gmail_id_shape", sql`${t.gmailMessageId} ~ '^[0-9a-f]{1,32}$'`),
    check("recruiter_grade_grade_valid", sql`${t.grade} in ('A', 'B', 'C', 'D', 'F')`),
    check("recruiter_grade_points_range", sql`${t.points} between -50 and 50`),
    check("recruiter_grade_confidence_valid", sql`${t.confidence} in ('normal', 'low')`),
    // Codes only, and no null among them (array_to_string would skip one): a reason can never
    // carry email text.
    check(
      "recruiter_grade_reasons_shape",
      sql`cardinality(${t.reasons}) between 1 and 12 and array_position(${t.reasons}, null) is null and array_to_string(${t.reasons}, ',') ~ '^(dealbreaker|[a-z_]+:[a-z_]+)(,(dealbreaker|[a-z_]+:[a-z_]+))*$'`,
    ),
  ],
);
