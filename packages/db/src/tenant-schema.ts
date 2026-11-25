import { ACCOUNT_STATUSES } from "@northstar/domain";
import { sql } from "drizzle-orm";
import { bigint, check, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { candidate } from "./schema.js";
import { TENANT_KEY_PATTERN } from "./vault-schema.js";

// The tenant registry (NS-124, ACC-001, ACC-006): each employer tenant Paul has, or is getting,
// an account on, and the history of that account's status. Both tables are append-only
// (migration trigger); write them only through tenant-write.ts. The account email and tenant URL
// never go into an event or span.

const STATUS_LIST = ACCOUNT_STATUSES.map((s) => `'${s}'`).join(", ");
// A reason code such as `started`, `email_sent`, `challenge`, `paul_finished`.
export const ACCOUNT_REASON_PATTERN = "^[a-z][a-z_]{0,39}$";

// One row per candidate and tenant, created once. The key is the vault's (`workday:acme`), so a
// tenant's account and its password share one name.
export const employerTenant = pgTable(
  "employer_tenant",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    tenantKey: text("tenant_key").notNull(),
    // The ATS kind, which is also the key's first part (`workday`).
    ats: text("ats").notNull(),
    // The tenant's sign-in page, https only.
    tenantUrl: text("tenant_url").notNull(),
    // The address the account is registered under. Paul's: never in events, spans or the API.
    accountEmail: text("account_email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("employer_tenant_one_per_key").on(t.candidateId, t.tenantKey),
    check("employer_tenant_key_valid", sql`${t.tenantKey} ~ ${sql.raw(`'${TENANT_KEY_PATTERN}'`)}`),
    check("employer_tenant_ats_matches_key", sql`${t.ats} = split_part(${t.tenantKey}, ':', 1)`),
    check("employer_tenant_url_https", sql`${t.tenantUrl} ~ '^https://[^\\s]+$'`),
    check("employer_tenant_url_length", sql`length(${t.tenantUrl}) <= 2048`),
    check(
      "employer_tenant_email_shape",
      sql`${t.accountEmail} ~ '^[^\\s@]+@[^\\s@]+$' and length(${t.accountEmail}) <= 320`,
    ),
  ],
);

// One row per status change. The newest (highest position) is the current status; a tenant with
// no row is `none`.
export const tenantAccountStatus = pgTable(
  "tenant_account_status",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Orders changes even when two land in the same instant.
    position: bigint("position", { mode: "bigint" }).notNull().generatedAlwaysAsIdentity(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => employerTenant.id),
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
    reason: text("reason").notNull(),
    // Who moved it: Paul (`user`) or the Apply Gateway (`agent:apply`).
    actor: text("actor").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("tenant_account_status_position_unique").on(t.position),
    check("tenant_account_status_from_valid", sql.raw(`from_status in (${STATUS_LIST})`)),
    check("tenant_account_status_to_valid", sql.raw(`to_status in (${STATUS_LIST})`)),
    check(
      "tenant_account_status_reason_valid",
      sql`${t.reason} ~ ${sql.raw(`'${ACCOUNT_REASON_PATTERN}'`)}`,
    ),
    check("tenant_account_status_actor_valid", sql`${t.actor} in ('user', 'agent:apply')`),
  ],
);
