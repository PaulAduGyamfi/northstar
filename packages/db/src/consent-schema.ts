import { CONSENT_POLICIES } from "@northstar/domain";
import { sql } from "drizzle-orm";
import { bigint, check, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { candidate } from "./schema.js";
import { employerTenant } from "./tenant-schema.js";

// The consent policy and the notices accepted under it (NS-124, ACC-008). Both tables are
// append-only (migration trigger); write them only through consent-write.ts. A notice's text and
// URL never go into an event or span: its kind and SHA-256 do.

const POLICY_LIST = CONSENT_POLICIES.map((p) => `'${p}'`).join(", ");
// A notice's text is kept whole, up to this many characters (a long privacy policy fits).
export const MAX_NOTICE_TEXT = 200_000;

// One row per change of Paul's setting. The newest is current; no row means `auto` (ACC-008).
export const consentPolicy = pgTable(
  "consent_policy",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    position: bigint("position", { mode: "bigint" }).notNull().generatedAlwaysAsIdentity(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    policy: text("policy").notNull(),
    setAt: timestamp("set_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("consent_policy_position_unique").on(t.position),
    check("consent_policy_valid", sql.raw(`policy in (${POLICY_LIST})`)),
  ],
);

// One row per notice accepted for Paul, with a snapshot of exactly what was accepted. Marketing
// opt-ins are always declined, so the database refuses them too.
export const consentRecord = pgTable(
  "consent_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => employerTenant.id),
    kind: text("kind").notNull(),
    noticeUrl: text("notice_url").notNull(),
    textSha256: text("text_sha256").notNull(),
    text: text("text").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("consent_record_kind_valid", sql`${t.kind} in ('terms', 'privacy')`),
    check("consent_record_url_https", sql`${t.noticeUrl} ~ '^https://[^\\s]+$'`),
    check("consent_record_url_length", sql`length(${t.noticeUrl}) <= 2048`),
    check("consent_record_sha256_hex", sql`${t.textSha256} ~ '^[0-9a-f]{64}$'`),
    check("consent_record_text_length", sql.raw(`length(text) between 1 and ${MAX_NOTICE_TEXT}`)),
    // The stored hash is the hash of the stored text, so the snapshot can't drift from it.
    check(
      "consent_record_sha256_matches",
      sql`${t.textSha256} = encode(sha256(convert_to(${t.text}, 'UTF8')), 'hex')`,
    ),
  ],
);
