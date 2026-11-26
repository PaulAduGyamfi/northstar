import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { approvalRequest } from "./approval-schema.js";
import { candidate } from "./schema.js";

// Reply drafts filed with the Approval Gate (NS-237, RPL-002): one row per Gate request, holding
// exactly what Paul approves and a later writer puts in the Gmail draft. Append-only (migration
// trigger), written only through reply-write.ts. The body is drafted from Paul's words and the
// recipient is a person's address: they stay in this table, never in an event, span or log.
export const replyDraft = pgTable(
  "reply_draft",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    requestId: uuid("request_id").notNull(),
    // Always email_reply: with content_sha256 it joins the foreign key, so a row can only sit
    // behind an email_reply request that pins this exact content.
    requestKind: text("request_kind").notNull().default("email_reply"),
    gmailMessageId: text("gmail_message_id").notNull(),
    threadId: text("thread_id").notNull(),
    toAddress: text("to_address").notNull(),
    subject: text("subject").notNull(),
    inReplyTo: text("in_reply_to").notNull(),
    references: jsonb("references").$type<string[]>().notNull(),
    body: text("body").notNull(),
    // Reply-To names another domain than From (replyToOtherDomain, packages/domain).
    replyToOtherDomain: boolean("reply_to_other_domain").notNull(),
    // The story and atom ids the draft cites, and the drafter's questions for Paul.
    cites: jsonb("cites").$type<string[]>().notNull(),
    followUps: jsonb("follow_ups").$type<string[]>().notNull(),
    // replyContentSha256 (packages/domain): the hash the Gate request pins.
    contentSha256: text("content_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One draft per Gate request; filing the same draft again stores nothing.
    unique("reply_draft_request_unique").on(t.requestId),
    foreignKey({
      name: "reply_draft_request_same_candidate_fk",
      columns: [t.requestId, t.candidateId, t.requestKind, t.contentSha256],
      foreignColumns: [
        approvalRequest.id,
        approvalRequest.candidateId,
        approvalRequest.kind,
        approvalRequest.contentSha256,
      ],
    }),
    check("reply_draft_request_kind", sql`${t.requestKind} = 'email_reply'`),
    check(
      "reply_draft_gmail_ids_shape",
      sql`${t.gmailMessageId} ~ '^[0-9a-f]{8,32}$' and ${t.threadId} ~ '^[0-9a-f]{8,32}$'`,
    ),
    check("reply_draft_sha256_shape", sql`${t.contentSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "reply_draft_to_shape",
      sql`char_length(${t.toAddress}) between 3 and 254 and ${t.toAddress} ~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$'`,
    ),
    // Header values with no line break or other control character: no header injection.
    check(
      "reply_draft_headers_no_control",
      sql`char_length(${t.subject}) between 1 and 300 and (${t.subject} || ${t.inReplyTo}) !~ '[[:cntrl:]]'`,
    ),
    check("reply_draft_body_shape", sql`char_length(${t.body}) between 1 and 5000`),
    check(
      "reply_draft_lists_shape",
      sql`jsonb_typeof(${t.references}) = 'array' and jsonb_typeof(${t.cites}) = 'array' and jsonb_typeof(${t.followUps}) = 'array'`,
    ),
  ],
);
