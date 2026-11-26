import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { approvalDecision } from "./approval-schema.js";
import { candidate } from "./schema.js";

// The credential vault (NS-122, ADR-0010, CRD-001/003). Write it only through vault-write.ts.
// It holds envelope-encrypted secrets and never a plaintext or key: sealing and opening happen in
// packages/gateways, the only code that holds the master key. Both tables are append-only
// (migration 0025).

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

// `<ats>:<tenant>` in lowercase, e.g. `workday:acme`: a fixed vocabulary, safe in events.
export const TENANT_KEY_PATTERN = "^[a-z0-9]+:[a-z0-9]+([_.-][a-z0-9]+)*$";
// A SHA-256 fingerprint of the master key, in hex: names the key, reveals nothing about it.
const KEY_ID_PATTERN = "^[0-9a-f]{64}$";

// One version of one tenant's secret. Rotation stores a new version; the newest is current.
export const vaultSecret = pgTable(
  "vault_secret",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    tenantKey: text("tenant_key").notNull(),
    version: integer("version").notNull(),
    // Which master key wrapped the data key (its fingerprint).
    masterKeyId: text("master_key_id").notNull(),
    // The data key, encrypted under the master key (AES-256-GCM): IV, ciphertext and tag.
    wrappedKeyIv: bytea("wrapped_key_iv").notNull(),
    wrappedKey: bytea("wrapped_key").notNull(),
    wrappedKeyTag: bytea("wrapped_key_tag").notNull(),
    // The secret, encrypted under the data key (AES-256-GCM): IV, ciphertext and tag.
    iv: bytea("iv").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    tag: bytea("tag").notNull(),
    storedAt: timestamp("stored_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("vault_secret_version_unique").on(t.candidateId, t.tenantKey, t.version),
    unique("vault_secret_id_candidate_unique").on(t.id, t.candidateId),
    check(
      "vault_secret_tenant_key_valid",
      sql`${t.tenantKey} ~ ${sql.raw(`'${TENANT_KEY_PATTERN}'`)}`,
    ),
    check(
      "vault_secret_master_key_id_valid",
      sql`${t.masterKeyId} ~ ${sql.raw(`'${KEY_ID_PATTERN}'`)}`,
    ),
    check("vault_secret_version_positive", sql`${t.version} >= 1`),
    // AES-GCM: 12-byte IVs, 16-byte tags, a 32-byte data key.
    check(
      "vault_secret_sizes",
      sql`octet_length(${t.wrappedKeyIv}) = 12 and octet_length(${t.iv}) = 12
        and octet_length(${t.wrappedKeyTag}) = 16 and octet_length(${t.tag}) = 16
        and octet_length(${t.wrappedKey}) = 32 and octet_length(${t.ciphertext}) >= 1`,
    ),
  ],
);

// Every opening of a secret (CRD-003): who, which secret, why, under which Gate decision, when.
// Written in the same transaction that hands out the sealed row, before anything is decrypted.
export const vaultAccess = pgTable(
  "vault_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    secretId: uuid("secret_id").notNull(),
    // `agent:<name>` (e.g. `agent:apply`): the code that asked, as in domain events.
    actor: text("actor").notNull(),
    // A fixed code (e.g. `sign_in`, `create_account`): never free text.
    purpose: text("purpose").notNull(),
    // The approvalId or policyDecisionId the opening acts under (ADR-0002, ADR-0010 item 2).
    decisionId: uuid("decision_id").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "vault_access_secret_same_candidate_fk",
      columns: [t.secretId, t.candidateId],
      foreignColumns: [vaultSecret.id, vaultSecret.candidateId],
    }),
    foreignKey({
      name: "vault_access_decision_same_candidate_fk",
      columns: [t.decisionId, t.candidateId],
      foreignColumns: [approvalDecision.id, approvalDecision.candidateId],
    }),
    // A reveal approval opens once (NS-182, ADR-0024): a backstop to the reveal path in vault-write.ts, which
    // makes a fresh approval for each reveal.
    uniqueIndex("vault_access_reveal_once")
      .on(t.decisionId)
      .where(sql`${t.purpose} = 'reveal_to_user'`),
    // An agent for its own purposes, or Paul only to reveal his own password (NS-182, ADR-0024).
    check(
      "vault_access_actor_valid",
      sql`(${t.actor} ~ '^agent:[a-z0-9-]+$' and ${t.purpose} <> 'reveal_to_user') or (${t.actor} = 'user' and ${t.purpose} = 'reveal_to_user')`,
    ),
    check("vault_access_purpose_valid", sql`${t.purpose} ~ '^[a-z]+(_[a-z]+)*$'`),
  ],
);
