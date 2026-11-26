import { sql } from "drizzle-orm";
import { bigint, check, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { candidate } from "./schema.js";

// Paul's contact details for application packages (NS-227 slice 3, APPLY-001): one row per change,
// the newest current. Append-only (migration trigger), written only through contact-write.ts.
// These are Paul's personal data: they stay in this table, never in an event, span or log.
export const profileContact = pgTable(
  "profile_contact",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Orders changes even when two land in the same instant.
    position: bigint("position", { mode: "bigint" }).notNull().generatedAlwaysAsIdentity(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email").notNull(),
    // Null when Paul gives no phone number.
    phone: text("phone"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("profile_contact_position_unique").on(t.position),
    // The same bounds as ContactDetails (packages/domain), so a stored contact fits a package.
    check("profile_contact_first_name_shape", sql`char_length(${t.firstName}) BETWEEN 1 AND 100`),
    check("profile_contact_last_name_shape", sql`char_length(${t.lastName}) BETWEEN 1 AND 100`),
    check(
      "profile_contact_email_shape",
      sql`char_length(${t.email}) BETWEEN 3 AND 254 AND ${t.email} LIKE '%_@_%'`,
    ),
    check(
      "profile_contact_phone_shape",
      sql`${t.phone} IS NULL OR char_length(${t.phone}) BETWEEN 1 AND 40`,
    ),
    // No control characters: these go onto forms as they are.
    check(
      "profile_contact_no_control_chars",
      sql`(${t.firstName} || ${t.lastName} || ${t.email} || coalesce(${t.phone}, '')) !~ '[[:cntrl:]]'`,
    ),
  ],
);
