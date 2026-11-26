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
import { candidate } from "./schema.js";

// Verification windows (NS-151, VER-001…006), shared by the process that reads mail and the
// gateway that waits for a code. Write them only through verification-write.ts. All four tables
// are append-only (a trigger): a resend or a close is a new row, never an edit. They hold names,
// domains, hosts, times and Gmail ids: never a code, link, subject, body or sender address.

const candidateId = () =>
  uuid("candidate_id")
    .notNull()
    .references(() => candidate.id);

export const WINDOW_PURPOSES = ["sign_up", "sign_in", "submit", "password_reset"] as const;
export const WINDOW_CLOSE_REASONS = [
  "verified",
  "link_host_not_allowed",
  "ambiguous_content",
  "message_too_large",
  "no_email",
] as const;

// A tenant or ATS is shown in the feed ("Acme", "Workday"): letters, digits, spaces and a few
// marks, never markup. The feed checks the same shape (packages/domain, feed.ts).
export const WINDOW_LABEL = /^[A-Za-z0-9][A-Za-z0-9 .&'-]{0,63}$/;

// One window: what the gateway step waits for, from whom, until when (VER-001).
export const verificationWindow = pgTable(
  "verification_window",
  {
    id: uuid("id").primaryKey(),
    candidateId: candidateId(),
    tenant: text("tenant").notNull(),
    ats: text("ats").notNull(),
    purpose: text("purpose").notNull(),
    senderDomains: text("sender_domains").array().notNull(),
    linkHosts: text("link_hosts").array().notNull(),
    // The window's length, kept so the one resend restarts it for the same time (VER-006).
    ttlMs: integer("ttl_ms").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("verification_window_id_candidate_unique").on(t.id, t.candidateId),
    check(
      "verification_window_tenant_shape",
      sql`${t.tenant} ~ '^[A-Za-z0-9][A-Za-z0-9 .&''-]{0,63}$'`,
    ),
    check("verification_window_ats_shape", sql`${t.ats} ~ '^[A-Za-z0-9][A-Za-z0-9 .&''-]{0,63}$'`),
    check(
      "verification_window_purpose_valid",
      sql`${t.purpose} in ('sign_up', 'sign_in', 'submit', 'password_reset')`,
    ),
    // 1 to 20 host names with at least one dot, lower case (the catcher's allowlist rule).
    check(
      "verification_window_senders_shape",
      sql`cardinality(${t.senderDomains}) between 1 and 20 and array_to_string(${t.senderDomains}, ' ') ~ '^[a-z0-9-]+([.][a-z0-9-]+)+( [a-z0-9-]+([.][a-z0-9-]+)+)*$'`,
    ),
    // 0 to 20 host names (none: links are never opened).
    check(
      "verification_window_hosts_shape",
      sql`cardinality(${t.linkHosts}) <= 20 and (cardinality(${t.linkHosts}) = 0 or array_to_string(${t.linkHosts}, ' ') ~ '^[a-z0-9-]+([.][a-z0-9-]+)+( [a-z0-9-]+([.][a-z0-9-]+)+)*$')`,
    ),
    // At most 30 minutes (MAX_WINDOW_MS in packages/inbox).
    check("verification_window_ttl_range", sql`${t.ttlMs} between 1 and 1800000`),
    check("verification_window_expiry_after_open", sql`${t.expiresAt} > ${t.openedAt}`),
  ],
);

// The one resend (VER-006): the window starts again at openedAt. One per window.
export const verificationWindowRestart = pgTable(
  "verification_window_restart",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: candidateId(),
    windowId: uuid("window_id").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("verification_window_restart_once").on(t.windowId),
    foreignKey({
      name: "verification_window_restart_window_fk",
      columns: [t.windowId, t.candidateId],
      foreignColumns: [verificationWindow.id, verificationWindow.candidateId],
    }),
    check("verification_window_restart_expiry_after_open", sql`${t.expiresAt} > ${t.openedAt}`),
  ],
);

// How a window ended. One per window: whichever process closes it first wins.
export const verificationWindowClose = pgTable(
  "verification_window_close",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: candidateId(),
    windowId: uuid("window_id").notNull(),
    reason: text("reason").notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("verification_window_close_once").on(t.windowId),
    foreignKey({
      name: "verification_window_close_window_fk",
      columns: [t.windowId, t.candidateId],
      foreignColumns: [verificationWindow.id, verificationWindow.candidateId],
    }),
    check(
      "verification_window_close_reason_valid",
      sql`${t.reason} in ('verified', 'link_host_not_allowed', 'ambiguous_content', 'message_too_large', 'no_email')`,
    ),
  ],
);

// A Gmail message given to a window: one email serves at most one window, in any process.
export const verificationUsedMessage = pgTable(
  "verification_used_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: candidateId(),
    gmailMessageId: text("gmail_message_id").notNull(),
    windowId: uuid("window_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("verification_used_message_once").on(t.candidateId, t.gmailMessageId),
    foreignKey({
      name: "verification_used_message_window_fk",
      columns: [t.windowId, t.candidateId],
      foreignColumns: [verificationWindow.id, verificationWindow.candidateId],
    }),
    // Gmail ids are hex; anything else is not a Gmail id.
    check("verification_used_message_id_shape", sql`${t.gmailMessageId} ~ '^[A-Za-z0-9_-]{1,64}$'`),
  ],
);
