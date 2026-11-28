import { sql } from "drizzle-orm";
import {
  bigint,
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

// Web push (NS-193, ADR-0032 items 5 and 6). All four tables are append-only (migration
// triggers), written only through push-write.ts (the notification claim and result: slice 3's
// writer, in the same file). They hold a browser's endpoint and keys, item
// keys, counts and outcomes: never a payload's words, a URL Paul opened, a company or a title.

// The push services ADR-0032 allows (packages/gateways endpoint.ts): https only. The exact host
// check stays in code (endpointAllowed); the database keeps the shape.
const ENDPOINT_SHAPE = "^https://[^\\s]+$";

// One per browser Paul turned notifications on in. A subscription is live while it has no
// removal; subscribing again after a removal is a new row (the same endpoint may come back).
export const pushSubscription = pgTable(
  "push_subscription",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Orders rows even when two land in the same instant.
    position: bigint("position", { mode: "bigint" }).notNull().generatedAlwaysAsIdentity(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    endpoint: text("endpoint").notNull(),
    // The browser's P-256 public point (65 bytes) and auth secret (16 bytes), base64url.
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("push_subscription_position_unique").on(t.position),
    unique("push_subscription_id_candidate_unique").on(t.id, t.candidateId),
    check(
      "push_subscription_endpoint_shape",
      sql`length(${t.endpoint}) <= 1024 AND ${t.endpoint} ~ ${sql.raw(`'${ENDPOINT_SHAPE}'`)}`,
    ),
    check("push_subscription_p256dh_shape", sql`${t.p256dh} ~ '^B[A-Za-z0-9_-]{86}$'`),
    check("push_subscription_auth_shape", sql`${t.auth} ~ '^[A-Za-z0-9_-]{22}$'`),
  ],
);

export const PUSH_REMOVAL_REASONS = ["user", "gone"] as const;
export type PushRemovalReason = (typeof PUSH_REMOVAL_REASONS)[number];

// One per subscription: Paul turned it off (`user`), or the push service said it no longer
// exists (`gone`, 404 or 410).
export const pushSubscriptionRemoval = pgTable(
  "push_subscription_removal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    subscriptionId: uuid("subscription_id").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("push_subscription_removal_once").on(t.subscriptionId),
    // The subscription must be this candidate's own.
    foreignKey({
      name: "push_subscription_removal_same_candidate_fk",
      columns: [t.subscriptionId, t.candidateId],
      foreignColumns: [pushSubscription.id, pushSubscription.candidateId],
    }),
    check("push_subscription_removal_reason_valid", sql`${t.reason} in ('user', 'gone')`),
  ],
);

// The item key a notification claims: one push per item, ever (ADR-0032 item 6). NS-193's is
// `apply_handoff:<uuid>:notify`, NS-199's `job_fresh_alert:<job uuid>:notify` (one per job, as
// the alert itself is); later kinds add their own prefix here and in the CHECK.
export const PUSH_ITEM_KEY_PATTERN =
  "^(apply_handoff|job_fresh_alert):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:notify$";

// The claim, written before any push goes out, so a second run sends nothing (at most once).
export const pushNotification = pgTable(
  "push_notification",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    itemKey: text("item_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("push_notification_once").on(t.candidateId, t.itemKey),
    unique("push_notification_id_candidate_unique").on(t.id, t.candidateId),
    check(
      "push_notification_item_key_shape",
      sql`${t.itemKey} ~ ${sql.raw(`'${PUSH_ITEM_KEY_PATTERN}'`)}`,
    ),
  ],
);

export const PUSH_OUTCOMES = ["sent", "failed"] as const;
export type PushOutcome = (typeof PUSH_OUTCOMES)[number];

// What a claim came to, once: `sent` when at least one browser took it, else `failed`. A claim
// with no result after its lease is an unknown outcome (a dead letter, never a second push).
export const pushNotificationResult = pgTable(
  "push_notification_result",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    notificationId: uuid("notification_id").notNull(),
    outcome: text("outcome").notNull(),
    // How many live subscriptions took it, were gone, or refused it.
    sentCount: integer("sent_count").notNull(),
    goneCount: integer("gone_count").notNull(),
    rejectedCount: integer("rejected_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("push_notification_result_once").on(t.notificationId),
    foreignKey({
      name: "push_notification_result_same_candidate_fk",
      columns: [t.notificationId, t.candidateId],
      foreignColumns: [pushNotification.id, pushNotification.candidateId],
    }),
    check("push_notification_result_outcome_valid", sql`${t.outcome} in ('sent', 'failed')`),
    check(
      "push_notification_result_counts",
      sql`${t.sentCount} >= 0 AND ${t.goneCount} >= 0 AND ${t.rejectedCount} >= 0 AND (${t.outcome} = 'sent') = (${t.sentCount} > 0)`,
    ),
  ],
);
