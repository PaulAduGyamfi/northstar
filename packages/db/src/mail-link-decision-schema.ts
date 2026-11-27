import { sql } from "drizzle-orm";
import { check, foreignKey, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { application, candidate } from "./schema.js";

// Paul's decision on a message in the confirm queue (NS-262, INB-006/009): linked to one of his
// applications, or dismissed. One row per queued Gmail message, written only by
// mail-link-decision-write.ts; append-only (migration trigger). Gmail ids and an application id
// only: never a subject, sender or body.
export const mailLinkDecision = pgTable(
  "mail_link_decision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    gmailMessageId: text("gmail_message_id").notNull(),
    gmailThreadId: text("gmail_thread_id").notNull(),
    decision: text("decision").notNull(),
    applicationId: uuid("application_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One decision per message: the first stands.
    unique("mail_link_decision_one_per_message").on(t.candidateId, t.gmailMessageId),
    // A linked message names one of the candidate's own applications.
    foreignKey({
      name: "mail_link_decision_application_same_candidate_fk",
      columns: [t.applicationId, t.candidateId],
      foreignColumns: [application.id, application.candidateId],
    }),
    // Only a queued mail_link row can be decided: the write checks it in its transaction. Not a
    // foreign key, as recruiter_grade: TRUNCATE would then fail on the key, not the trigger.
    check(
      "mail_link_decision_gmail_ids_shape",
      sql`${t.gmailMessageId} ~ '^[0-9a-f]{1,32}$' and ${t.gmailThreadId} ~ '^[0-9a-f]{1,32}$'`,
    ),
    check(
      "mail_link_decision_shape",
      sql`(${t.decision} = 'linked' and ${t.applicationId} is not null)
        or (${t.decision} = 'dismissed' and ${t.applicationId} is null)`,
    ),
  ],
);
