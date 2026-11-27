import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { candidate } from "./schema.js";

// Paul's own letter for a graded recruiter message (NS-238 item 3, REC-003): one row per change,
// the newest per message is current. Letters and ids only, never email text. Append-only
// (migration trigger), written only through recruiter-regrade-write.ts.
export const recruiterRegrade = pgTable(
  "recruiter_regrade",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    gmailMessageId: text("gmail_message_id").notNull(),
    grade: text("grade").notNull(),
    regradedAt: timestamp("regraded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The newest regrade per message is read by candidate and message.
    index("recruiter_regrade_message").on(t.candidateId, t.gmailMessageId, t.regradedAt),
    // Only a graded message can be regraded: the write checks its recruiter_grade in the same
    // transaction. Not a foreign key, as recruiter_grade: TRUNCATE would then fail on the key.
    check("recruiter_regrade_gmail_id_shape", sql`${t.gmailMessageId} ~ '^[0-9a-f]{1,32}$'`),
    check("recruiter_regrade_grade_valid", sql`${t.grade} in ('A', 'B', 'C', 'D', 'F')`),
  ],
);
