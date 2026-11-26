import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { experienceAtom, profileSource } from "./profile-schema.js";
import { candidate } from "./schema.js";

// Resume audits and Paul's decisions on them (NS-190, AUD-001/002): every run, its suggestions,
// his accept/reject decisions and the atom lines he wrote. All append-only (migration triggers),
// written only through audit-write.ts. Lines and messages stay in these tables, never in an
// event or span.

const candidateRef = () =>
  uuid("candidate_id")
    .notNull()
    .references(() => candidate.id);

// One audit run over one resume import.
export const resumeAudit = pgTable(
  "resume_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: candidateRef(),
    // The resume import the master came from; a decision is refused once it is superseded.
    profileSourceId: uuid("profile_source_id").notNull(),
    // The titles and requirements the keyword score was measured against.
    targets: text("targets").array().notNull(),
    // The six dimension scores (0–100 each), keyed by dimension.
    scores: jsonb("scores").$type<Record<string, number>>().notNull(),
    overall: integer("overall").notNull(),
    pages: integer("pages").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Target of the same-candidate foreign keys below.
    unique("resume_audit_id_candidate_unique").on(t.id, t.candidateId),
    check("resume_audit_overall_range", sql`${t.overall} between 0 and 100`),
    check("resume_audit_pages_positive", sql`${t.pages} >= 1`),
    foreignKey({
      name: "resume_audit_source_same_candidate_fk",
      columns: [t.profileSourceId, t.candidateId],
      foreignColumns: [profileSource.id, profileSource.candidateId],
    }),
  ],
);

// Each suggestion of a run, under its stable key (`<kind>:<target>`, auditResume).
export const resumeAuditSuggestion = pgTable(
  "resume_audit_suggestion",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: candidateRef(),
    auditId: uuid("audit_id").notNull(),
    key: text("key").notNull(),
    kind: text("kind").notNull(),
    dimension: text("dimension").notNull(),
    // { atomId } | { roleId } | { term } | { resume: true }
    target: jsonb("target").$type<Record<string, unknown>>().notNull(),
    message: text("message").notNull(),
    // Order in the run (0-based): atoms, roles, terms, then the whole resume (auditResume).
    position: integer("position").notNull(),
  },
  (t) => [
    unique("resume_audit_suggestion_key_unique").on(t.auditId, t.key),
    unique("resume_audit_suggestion_position_unique").on(t.auditId, t.position),
    check("resume_audit_suggestion_key_not_empty", sql`length(${t.key}) > 0`),
    foreignKey({
      name: "resume_audit_suggestion_audit_same_candidate_fk",
      columns: [t.auditId, t.candidateId],
      foreignColumns: [resumeAudit.id, resumeAudit.candidateId],
    }),
  ],
);

// Paul's decision on one suggestion of one run: accepted with his new line, or rejected.
export const resumeAuditDecision = pgTable(
  "resume_audit_decision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: candidateRef(),
    auditId: uuid("audit_id").notNull(),
    key: text("key").notNull(),
    decision: text("decision").notNull(),
    // Paul's own line when accepted; null when rejected.
    newLine: text("new_line"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At most one decision per suggestion of a run.
    unique("resume_audit_decision_once").on(t.auditId, t.key),
    // Target of atom_line_edit's same-candidate foreign key.
    unique("resume_audit_decision_id_candidate_unique").on(t.id, t.candidateId),
    check(
      "resume_audit_decision_valid",
      sql`(${t.decision} = 'accepted' and ${t.newLine} is not null and length(trim(${t.newLine})) > 0)
        or (${t.decision} = 'rejected' and ${t.newLine} is null)`,
    ),
    // One line: a line break or control character could start a fake header when rendered.
    check(
      "resume_audit_decision_one_line",
      sql`${t.newLine} is null or ${t.newLine} !~ '[[:cntrl:]]'`,
    ),
    foreignKey({
      name: "resume_audit_decision_audit_same_candidate_fk",
      columns: [t.auditId, t.candidateId],
      foreignColumns: [resumeAudit.id, resumeAudit.candidateId],
    }),
    // A decision is about a suggestion that run really made.
    foreignKey({
      name: "resume_audit_decision_suggestion_fk",
      columns: [t.auditId, t.key],
      foreignColumns: [resumeAuditSuggestion.auditId, resumeAuditSuggestion.key],
    }),
  ],
);

// A new version of one atom's resume line, from an accepted decision. The atom's own
// source_quote (the verbatim resume text) never changes; the newest edit is the current line.
export const atomLineEdit = pgTable(
  "atom_line_edit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: candidateRef(),
    atomId: uuid("atom_id").notNull(),
    // The decision it came from, and through it the audit: its provenance.
    decisionId: uuid("decision_id").notNull(),
    line: text("line").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One edit per decision.
    unique("atom_line_edit_decision_unique").on(t.decisionId),
    check("atom_line_edit_line_not_empty", sql`length(trim(${t.line})) > 0`),
    check("atom_line_edit_one_line", sql`${t.line} !~ '[[:cntrl:]]'`),
    foreignKey({
      name: "atom_line_edit_atom_same_candidate_fk",
      columns: [t.atomId, t.candidateId],
      foreignColumns: [experienceAtom.id, experienceAtom.candidateId],
    }),
    foreignKey({
      name: "atom_line_edit_decision_same_candidate_fk",
      columns: [t.decisionId, t.candidateId],
      foreignColumns: [resumeAuditDecision.id, resumeAuditDecision.candidateId],
    }),
  ],
);
