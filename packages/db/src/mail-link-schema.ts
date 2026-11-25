import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { application, candidate } from "./schema.js";

// Linking job mail to applications (NS-158, VER-007, INB-009/011). Write it only through
// mail-link-write.ts. Both tables are append-only (migration 0029). They hold Gmail ids, tags,
// steps and reasons: never an address, subject, sender or body.

const candidateId = () =>
  uuid("candidate_id")
    .notNull()
    .references(() => candidate.id);

// One plus-address tag (VER-007): for one application, or for one tenant (`workday:acme`) when
// the account email has to stay fixed. A tag is never reused, and each application or tenant
// keeps its first tag.
export const mailTag = pgTable(
  "mail_tag",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: candidateId(),
    tag: text("tag").notNull(),
    applicationId: uuid("application_id"),
    tenantKey: text("tenant_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("mail_tag_tag_unique").on(t.candidateId, t.tag),
    uniqueIndex("mail_tag_one_per_application")
      .on(t.candidateId, t.applicationId)
      .where(sql`${t.applicationId} is not null`),
    uniqueIndex("mail_tag_one_per_tenant")
      .on(t.candidateId, t.tenantKey)
      .where(sql`${t.tenantKey} is not null`),
    foreignKey({
      name: "mail_tag_application_same_candidate_fk",
      columns: [t.applicationId, t.candidateId],
      foreignColumns: [application.id, application.candidateId],
    }),
    // 6 base32 characters (packages/inbox, tag.ts).
    check("mail_tag_tag_shape", sql`${t.tag} ~ '^[a-z2-7]{6}$'`),
    check("mail_tag_one_target", sql`(${t.applicationId} is null) <> (${t.tenantKey} is null)`),
    check(
      "mail_tag_tenant_key_shape",
      sql`${t.tenantKey} is null or ${t.tenantKey} ~ '^[a-z0-9]+:[a-z0-9]+([_.-][a-z0-9]+)*$'`,
    ),
  ],
);

export const MATCH_STEPS = ["tag", "thread", "sender"] as const;
export const QUEUE_REASONS = ["unknown_tag", "ambiguous", "no_match"] as const;

// What matching decided for one Gmail message: linked to an application by a step, or queued for
// Paul with a reason (the "confirm link" queue). One row per message, written once.
export const mailLink = pgTable(
  "mail_link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: candidateId(),
    gmailMessageId: text("gmail_message_id").notNull(),
    gmailThreadId: text("gmail_thread_id").notNull(),
    applicationId: uuid("application_id"),
    step: text("step"),
    queueReason: text("queue_reason"),
    // An authenticated domain is under the application's company or ATS domains (INB-011).
    senderVerified: boolean("sender_verified").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("mail_link_one_per_message").on(t.candidateId, t.gmailMessageId),
    foreignKey({
      name: "mail_link_application_same_candidate_fk",
      columns: [t.applicationId, t.candidateId],
      foreignColumns: [application.id, application.candidateId],
    }),
    // Gmail ids are hex strings; never free text.
    check(
      "mail_link_gmail_ids_shape",
      sql`${t.gmailMessageId} ~ '^[0-9a-f]{1,32}$' and ${t.gmailThreadId} ~ '^[0-9a-f]{1,32}$'`,
    ),
    // Linked: an application and a step, no reason. Queued: a reason, no application or step,
    // and never verified.
    check(
      "mail_link_linked_or_queued",
      sql`(${t.applicationId} is not null and ${t.step} in ('tag', 'thread', 'sender') and ${t.queueReason} is null)
        or (${t.applicationId} is null and ${t.step} is null and ${t.senderVerified} = false
            and ${t.queueReason} in ('unknown_tag', 'ambiguous', 'no_match'))`,
    ),
  ],
);
