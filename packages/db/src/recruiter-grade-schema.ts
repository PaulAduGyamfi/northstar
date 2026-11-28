import { RECRUITER_GRADE_REASONS } from "@northstar/domain";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { candidate } from "./schema.js";

// The fixed reason list as SQL literals, for the CHECK: constants only, never input.
const REASON_LIST = sql.raw(RECRUITER_GRADE_REASONS.map((r) => `'${r}'`).join(", "));
// The reasons that cap a letter (a dealbreaker makes it F, a red flag F or D), also constants only.
const CAP_LIST = sql.raw(
  RECRUITER_GRADE_REASONS.filter((r) => r === "dealbreaker" || r.startsWith("red_flag:"))
    .map((r) => `'${r}'`)
    .join(", "),
);

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
    // Codes from RECRUITER_GRADE_REASONS (@northstar/domain) only.
    reasons: text("reasons").array().notNull(),
    confidence: text("confidence").notNull(),
    // NS-238 item 3 slice 3: the grade with Paul's learned weights applied, and the
    // recruiter_weight version that produced it. `grade` and `points` stay the grader's own,
    // unweighted result, which learning compares his letter with; these are what the Inbox shows.
    // All null when no weights existed (and on every grade stored before migration 0107).
    weightedGrade: text("weighted_grade"),
    weightedPoints: integer("weighted_points"),
    weightsPosition: bigint("weights_position", { mode: "bigint" }),
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
    // The weighted part is whole or absent, its letter a letter, and its points at most
    // MAX_TOTAL_ADJUSTMENT (2) from the grader's own: learning nudges a grade, never rewrites it.
    // Every branch names each column `is not null`, so no part of it can evaluate to NULL (a CHECK
    // that evaluates to NULL passes).
    check(
      "recruiter_grade_weighted_whole",
      sql`(${t.weightedGrade} is null and ${t.weightedPoints} is null and ${t.weightsPosition} is null) or (${t.weightedGrade} is not null and ${t.weightedPoints} is not null and ${t.weightsPosition} is not null and ${t.weightedGrade} in ('A', 'B', 'C', 'D', 'F') and ${t.weightedPoints} between ${t.points} - 2 and ${t.points} + 2 and ${t.weightsPosition} > 0)`,
    ),
    // A capped grade (a dealbreaker or any red flag: F or at most D) keeps its cap: the weighted
    // letter is never better than the grader's. Letters rank by their place in 'ABCDF'.
    check(
      "recruiter_grade_weighted_keeps_cap",
      sql`${t.weightedGrade} is null or not (${t.reasons} && array[${CAP_LIST}]::text[]) or strpos('ABCDF', ${t.weightedGrade}) >= strpos('ABCDF', ${t.grade})`,
    ),
    // Listed codes only, and no null: a reason can never carry email text.
    check(
      "recruiter_grade_reasons_listed",
      sql`cardinality(${t.reasons}) between 1 and 12 and array_position(${t.reasons}, null) is null and ${t.reasons} <@ array[${REASON_LIST}]::text[]`,
    ),
  ],
);
