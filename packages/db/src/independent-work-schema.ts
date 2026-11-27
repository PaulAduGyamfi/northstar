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

// Paul's independent work since his last role (NS-196, DX-010): the gap-to-proof entries. Each
// `profile work set` stores a new version of the whole list; the newest version is current, and
// older ones stay. All three tables are append-only (migration 0059); write them only through
// independent-work-write.ts. Titles and lines are Paul's own words: never in events, spans or logs.

const MONTH = "'^[0-9]{4}-(0[1-9]|1[0-2])$'";

export const independentWorkSet = pgTable(
  "independent_work_set",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    version: integer("version").notNull(),
    // SHA-256 of the entries as stored: the same file again stores nothing.
    contentSha256: text("content_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("independent_work_set_id_candidate_unique").on(t.id, t.candidateId),
    unique("independent_work_set_version_unique").on(t.candidateId, t.version),
    check("independent_work_set_version_positive", sql`${t.version} >= 1`),
    check("independent_work_set_sha256_format", sql`${t.contentSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

// Migration 0092 (NS-231 slice 5) adds CHECKs, NOT VALID, refusing the invisible characters the
// parser refuses in a title, link or line (`*_no_invisible`). They live only in that custom migration:
// Drizzle can't express NOT VALID.
export const independentWorkEntry = pgTable(
  "independent_work_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    setId: uuid("set_id").notNull(),
    // Order in Paul's file (0-based).
    position: integer("position").notNull(),
    title: text("title").notNull(),
    // YYYY-MM.
    startedOn: text("started_on").notNull(),
    // YYYY-MM, or null while the work is ongoing.
    endedOn: text("ended_on"),
    link: text("link"),
  },
  (t) => [
    unique("independent_work_entry_id_candidate_unique").on(t.id, t.candidateId),
    unique("independent_work_entry_position_unique").on(t.setId, t.position),
    foreignKey({
      name: "independent_work_entry_set_same_candidate_fk",
      columns: [t.setId, t.candidateId],
      foreignColumns: [independentWorkSet.id, independentWorkSet.candidateId],
    }),
    check("independent_work_entry_position_valid", sql`${t.position} between 0 and 9`),
    check(
      "independent_work_entry_title_shape",
      sql`length(trim(${t.title})) between 1 and 80 and ${t.title} !~ '[[:cntrl:]]'`,
    ),
    check("independent_work_entry_start_format", sql`${t.startedOn} ~ ${sql.raw(MONTH)}`),
    check(
      "independent_work_entry_end_format",
      sql`${t.endedOn} is null or (${t.endedOn} ~ ${sql.raw(MONTH)} and ${t.endedOn} >= ${t.startedOn})`,
    ),
    check(
      "independent_work_entry_link_https",
      sql`${t.link} is null or (${t.link} ~ '^https://' and length(${t.link}) <= 300 and ${t.link} !~ '[[:cntrl:]]')`,
    ),
  ],
);

export const independentWorkLine = pgTable(
  "independent_work_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    entryId: uuid("entry_id").notNull(),
    // Order within the entry (0-based).
    position: integer("position").notNull(),
    // Paul's own line of proof, verbatim.
    text: text("text").notNull(),
  },
  (t) => [
    unique("independent_work_line_position_unique").on(t.entryId, t.position),
    foreignKey({
      name: "independent_work_line_entry_same_candidate_fk",
      columns: [t.entryId, t.candidateId],
      foreignColumns: [independentWorkEntry.id, independentWorkEntry.candidateId],
    }),
    check("independent_work_line_position_valid", sql`${t.position} between 0 and 5`),
    check(
      "independent_work_line_text_shape",
      sql`length(trim(${t.text})) between 1 and 200 and ${t.text} !~ '[[:cntrl:]]'`,
    ),
  ],
);
