import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { candidate } from "./schema.js";

// The candidate profile graph (ADR-0004, CPG-001/002/004, NS-110). Every row names its candidate
// (Q-02), and child rows point at their source and role through same-candidate composite keys.

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const candidateId = () =>
  uuid("candidate_id")
    .notNull()
    .references(() => candidate.id);

// Dates keep the precision the source gives: "YYYY-MM", or "YYYY" for a year only. Never a
// made-up month or day: that would be a fabricated fact.
const MONTH = "'^[0-9]{4}(-(0[1-9]|1[0-2]))?$'";
const monthCheck = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} is null or ${column} ~ ${sql.raw(MONTH)}`);

// One import of one document. Re-importing the same text is a no-op (matched on text_sha256), and
// a new version marks the previous one superseded; its rows stay for history.
export const profileSource = pgTable(
  "profile_source",
  {
    id: id(),
    candidateId: candidateId(),
    kind: text("kind").notNull(),
    fileName: text("file_name").notNull(),
    textSha256: text("text_sha256").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => [
    check("profile_source_kind_valid", sql`${t.kind} in ('resume')`),
    check("profile_source_sha_format", sql`${t.textSha256} ~ '^[0-9a-f]{64}$'`),
    unique("profile_source_id_candidate_unique").on(t.id, t.candidateId),
    // At most one current source of each kind per candidate.
    uniqueIndex("profile_source_one_current")
      .on(t.candidateId, t.kind)
      .where(sql`${t.supersededAt} is null`),
  ],
);

// Child rows reference their source through (source_id, candidate_id), so a row can never point
// at another candidate's source.
const sourceFk = (name: string, t: { sourceId: AnyPgColumn; candidateId: AnyPgColumn }) =>
  foreignKey({
    name,
    columns: [t.sourceId, t.candidateId],
    foreignColumns: [profileSource.id, profileSource.candidateId],
  });

// Locked facts (CPG-004): employer, title, dates and is_current. A trigger refuses changes unless the
// transaction set northstar.locked_edit = 'user' (editLockedFact, Paul's own edits only).
export const role = pgTable(
  "role",
  {
    id: id(),
    candidateId: candidateId(),
    sourceId: uuid("source_id").notNull(),
    employer: text("employer").notNull(),
    title: text("title").notNull(),
    startMonth: text("start_month"),
    // null means "not stated"; an ongoing role is is_current, never a null end date.
    endMonth: text("end_month"),
    isCurrent: boolean("is_current").notNull().default(false),
    locked: boolean("locked").notNull().default(true),
    // Order in the resume (0-based): rows from one import share created_at.
    position: integer("position").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("role_id_candidate_unique").on(t.id, t.candidateId),
    sourceFk("role_source_same_candidate_fk", t),
    monthCheck("role_start_month_format", t.startMonth),
    monthCheck("role_end_month_format", t.endMonth),
    // An ongoing role has no end date; the import validator checks this too, the database
    // makes sure editLockedFact can't break it.
    check("role_current_has_no_end", sql`not ${t.isCurrent} or ${t.endMonth} is null`),
  ],
);

export const education = pgTable(
  "education",
  {
    id: id(),
    candidateId: candidateId(),
    sourceId: uuid("source_id").notNull(),
    school: text("school").notNull(),
    degree: text("degree"),
    field: text("field"),
    startMonth: text("start_month"),
    endMonth: text("end_month"),
    locked: boolean("locked").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    sourceFk("education_source_same_candidate_fk", t),
    monthCheck("education_start_month_format", t.startMonth),
    monthCheck("education_end_month_format", t.endMonth),
  ],
);

// One fact Paul did (CPG-002). source_quote is the exact resume sentence it rests on; the
// provenance validator in packages/profile checks it verbatim before anything is written.
export const experienceAtom = pgTable(
  "experience_atom",
  {
    id: id(),
    candidateId: candidateId(),
    sourceId: uuid("source_id").notNull(),
    roleId: uuid("role_id"),
    what: text("what").notNull(),
    how: text("how").array().notNull().default(sql`'{}'::text[]`),
    // Only what the resume says; null when it gives no impact or scope.
    impact: text("impact"),
    scope: text("scope"),
    startMonth: text("start_month"),
    endMonth: text("end_month"),
    sourceQuote: text("source_quote").notNull(),
    evidenceLink: text("evidence_link"),
    // Order in the resume (0-based).
    position: integer("position").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // Target of the same-candidate foreign keys from the story bank (story-schema.ts).
    unique("experience_atom_id_candidate_unique").on(t.id, t.candidateId),
    sourceFk("experience_atom_source_same_candidate_fk", t),
    foreignKey({
      name: "experience_atom_role_same_candidate_fk",
      columns: [t.roleId, t.candidateId],
      foreignColumns: [role.id, role.candidateId],
    }),
    check("experience_atom_quote_not_empty", sql`length(trim(${t.sourceQuote})) > 0`),
    check(
      "experience_atom_evidence_link_http",
      sql`${t.evidenceLink} is null or ${t.evidenceLink} ~ '^https?://'`,
    ),
    monthCheck("experience_atom_start_month_format", t.startMonth),
    monthCheck("experience_atom_end_month_format", t.endMonth),
  ],
);

export const skill = pgTable(
  "skill",
  {
    id: id(),
    candidateId: candidateId(),
    sourceId: uuid("source_id").notNull(),
    name: text("name").notNull(),
  },
  (t) => [
    sourceFk("skill_source_same_candidate_fk", t),
    unique("skill_unique_per_source").on(t.candidateId, t.sourceId, t.name),
  ],
);

export const certification = pgTable(
  "certification",
  {
    id: id(),
    candidateId: candidateId(),
    sourceId: uuid("source_id").notNull(),
    name: text("name").notNull(),
    issuer: text("issuer"),
    issuedMonth: text("issued_month"),
  },
  (t) => [
    sourceFk("certification_source_same_candidate_fk", t),
    monthCheck("certification_issued_month_format", t.issuedMonth),
  ],
);

// The official employment record (DX-011): what Paul's employers' HR records say, entered by Paul.
// It is the single source of truth that the resume, LinkedIn, site and application forms are
// checked against. Dates are "YYYY-MM" or "YYYY-MM-DD" (HR records are at least that precise).
// Setting a new record marks the old rows superseded; nothing is deleted.
const DATE = "'^[0-9]{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12][0-9]|3[01]))?$'";
export const employmentFact = pgTable(
  "employment_fact",
  {
    id: id(),
    candidateId: candidateId(),
    employer: text("employer").notNull(),
    title: text("title").notNull(),
    startDate: text("start_date").notNull(),
    // null exactly when the position is ongoing.
    endDate: text("end_date"),
    isCurrent: boolean("is_current").notNull(),
    // Order in Paul's record file (0-based); rows from one record share created_at.
    position: integer("position").notNull(),
    createdAt: createdAt(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => [
    // One active record per candidate: if two `facts set` runs race, the second one's insert
    // fails instead of leaving two mixed sets as the source of truth.
    uniqueIndex("employment_fact_one_active_position")
      .on(t.candidateId, t.position)
      .where(sql`${t.supersededAt} is null`),
    check("employment_fact_start_format", sql`${t.startDate} ~ ${sql.raw(DATE)}`),
    check(
      "employment_fact_end_format",
      sql`${t.endDate} is null or ${t.endDate} ~ ${sql.raw(DATE)}`,
    ),
    check("employment_fact_current_xor_end", sql`${t.isCurrent} = (${t.endDate} is null)`),
    check(
      "employment_fact_not_blank",
      sql`length(trim(${t.employer})) > 0 and length(trim(${t.title})) > 0`,
    ),
  ],
);

export const profileLink = pgTable(
  "profile_link",
  {
    id: id(),
    candidateId: candidateId(),
    sourceId: uuid("source_id").notNull(),
    label: text("label").notNull(),
    url: text("url").notNull(),
  },
  (t) => [
    sourceFk("profile_link_source_same_candidate_fk", t),
    // Links are shown as anchors later; never javascript: or data:.
    check("profile_link_url_http", sql`${t.url} ~ '^https?://'`),
  ],
);
