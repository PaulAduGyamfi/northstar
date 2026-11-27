import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { MAIL_KINDS, STAGE_SIGNALS } from "./funnel-schema.js";
import { candidate } from "./schema.js";

// Why a message went to Paul's review instead of being classified: the triage step's reasons
// (classifyLinkedMail in @northstar/inbox, its ReviewReason type): keep the two lists the same.
export const CLASSIFICATION_REVIEW_REASONS = [
  "refused",
  "truncated",
  "invalid_output",
  "ambiguous",
  "provenance",
] as const;

// Constants only, never input, so sql.raw builds no SQL from data.
const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

// A linked message's classification (NS-261, INB-003/012): one decision per recorded Gmail
// message, the kind and stage signal, or a review reason. Codes only: the classification's
// extracted company, role and requisition, and any subject, body or address, never come here.
// Append-only (migration trigger), written only through mail-classification-write.ts.
export const mailClassification = pgTable(
  "mail_classification",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    gmailMessageId: text("gmail_message_id").notNull(),
    outcome: text("outcome").notNull(),
    kind: text("kind"),
    stageSignal: text("stage_signal"),
    decidedBy: text("decided_by").notNull(),
    reviewReason: text("review_reason"),
    // The mail-classify prompt's version when the model decided; null for rules.
    promptVersion: integer("prompt_version"),
    classifiedAt: timestamp("classified_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One decision per message: the first stands. Not a foreign key to mail_link (as for
    // recruiter_grade): the write checks the message's link in its transaction.
    unique("mail_classification_one_per_message").on(t.candidateId, t.gmailMessageId),
    check("mail_classification_gmail_id_shape", sql`${t.gmailMessageId} ~ '^[0-9a-f]{1,32}$'`),
    check("mail_classification_decided_by_valid", sql`${t.decidedBy} in ('rules', 'model')`),
    // Classified: a listed kind and stage, no review reason. Review: a listed reason, no kind or
    // stage, decided by the model. Skipped (NS-271): verification mail left alone (INB-012), with
    // no kind, stage or reason, decided by rules. NULL-safe: a CHECK that evaluates to NULL would
    // let a row in.
    check(
      "mail_classification_shape",
      sql`(${t.outcome} = 'classified' and ${t.kind} is not null and ${t.kind} in (${inList(MAIL_KINDS)})
            and ${t.stageSignal} is not null and ${t.stageSignal} in (${inList(STAGE_SIGNALS)})
            and ${t.reviewReason} is null)
        or (${t.outcome} = 'review' and ${t.kind} is null and ${t.stageSignal} is null
            and ${t.reviewReason} is not null
            and ${t.reviewReason} in (${inList(CLASSIFICATION_REVIEW_REASONS)})
            and ${t.decidedBy} = 'model')
        or (${t.outcome} = 'skipped' and ${t.kind} is null and ${t.stageSignal} is null
            and ${t.reviewReason} is null and ${t.decidedBy} = 'rules')`,
    ),
    // A model's decision names its prompt version; a rules decision has none.
    check(
      "mail_classification_prompt_version",
      sql`(${t.decidedBy} = 'model' and ${t.promptVersion} is not null and ${t.promptVersion} between 1 and 9999)
        or (${t.decidedBy} = 'rules' and ${t.promptVersion} is null)`,
    ),
  ],
);
