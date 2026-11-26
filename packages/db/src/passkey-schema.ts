import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  foreignKey,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { candidate } from "./schema.js";

// Paul's passkeys (NS-178, ADR-0022). Write them only through passkey-write.ts. Both tables are
// append-only (triggers, migration 0051): a credential is never edited or deleted, and each
// sign-in adds a use with the authenticator's sign count, so the newest count is read, never set.

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

// One registered passkey. The public key is not a secret, but it and the credential id are only
// for verifying a sign-in: never put either in an event, span or log.
export const passkeyCredential = pgTable(
  "passkey_credential",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    // The authenticator's credential id, base64url (WebAuthn's rawId).
    credentialId: text("credential_id").notNull(),
    // The COSE public key from registration.
    publicKey: bytea("public_key").notNull(),
    // The sign count at registration; later counts are in passkey_use.
    signCount: bigint("sign_count", { mode: "number" }).notNull(),
    // Hints the browser uses to find the authenticator ("internal", "hybrid", "usb", ...).
    transports: text("transports").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A credential id names one authenticator key wherever it's registered.
    unique("passkey_credential_id_unique").on(t.credentialId),
    // Target of passkey_use's same-candidate foreign key.
    unique("passkey_credential_id_candidate_unique").on(t.id, t.candidateId),
    check(
      "passkey_credential_id_shape",
      sql`${t.credentialId} ~ '^[A-Za-z0-9_-]+$' and char_length(${t.credentialId}) between 16 and 1366`,
    ),
    check("passkey_credential_sign_count_valid", sql`${t.signCount} >= 0`),
    check(
      "passkey_credential_public_key_size",
      sql`octet_length(${t.publicKey}) between 1 and 2048`,
    ),
  ],
);

// One successful sign-in with a passkey, with the sign count the authenticator reported.
export const passkeyUse = pgTable(
  "passkey_use",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    passkeyId: uuid("passkey_id").notNull(),
    signCount: bigint("sign_count", { mode: "number" }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "passkey_use_passkey_same_candidate_fk",
      columns: [t.passkeyId, t.candidateId],
      foreignColumns: [passkeyCredential.id, passkeyCredential.candidateId],
    }),
    check("passkey_use_sign_count_valid", sql`${t.signCount} >= 0`),
    // Two sign-ins can't both claim the same non-zero count (a replay or a cloned key). Platform
    // passkeys always report 0, so 0 may repeat (ADR-0022).
    uniqueIndex("passkey_use_one_per_count")
      .on(t.passkeyId, t.signCount)
      .where(sql`${t.signCount} > 0`),
  ],
);
