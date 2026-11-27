import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { candidate, company } from "./schema.js";

// A company's own mail domains (NS-252, INB-009/011): one row per change, the newest per company
// and domain current. Paul enters them (`jobs domains`), so the source is `paul`; suggestions from
// confirmed links come later and need his acceptance. Never the apply URL's host or ATS metadata.
// matchMail links by sender only for an authenticated domain under one of these. Append-only
// (migration trigger), written only through company-domain-write.ts.
export const companyDomain = pgTable(
  "company_domain",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Orders changes even when two land in the same instant.
    position: bigint("position", { mode: "bigint" }).notNull().generatedAlwaysAsIdentity(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    companyId: uuid("company_id").notNull(),
    // Lower case, no trailing dot, at least one dot (never a bare suffix such as `com`).
    domain: text("domain").notNull(),
    action: text("action").notNull(),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("company_domain_position_unique").on(t.position),
    // The company must be this candidate's own.
    foreignKey({
      name: "company_domain_company_same_candidate_fk",
      columns: [t.companyId, t.candidateId],
      foreignColumns: [company.id, company.candidateId],
    }),
    check(
      "company_domain_domain_shape",
      sql`length(${t.domain}) BETWEEN 3 AND 253 AND ${t.domain} ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'`,
    ),
    check("company_domain_action_valid", sql`${t.action} in ('add', 'remove')`),
    check("company_domain_source_valid", sql`${t.source} in ('paul')`),
  ],
);
