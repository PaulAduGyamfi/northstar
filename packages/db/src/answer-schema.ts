import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { approvalDecision } from "./approval-schema.js";
import { experienceAtom } from "./profile-schema.js";
import { application, candidate } from "./schema.js";
import { story } from "./story-schema.js";

// The answer bank (ANS-003, ANS-005, ANS-006, GH-59): Paul's approved answers to narrative
// canonical questions, what they cite and where they were used. All three tables are append-only
// (a trigger in migration 0018 refuses UPDATE, DELETE and TRUNCATE). Write them only through
// answer-write.ts. The answer text is Paul's words: it never goes into events, spans or logs.

// The kinds the bank stores. Factual questions are answered from settings, never banked.
export const BANK_KINDS = ["reusable_narrative", "company_specific"] as const;
export type BankKind = (typeof BANK_KINDS)[number];
const kindList = sql.raw(BANK_KINDS.map((k) => `'${k}'`).join(", "));

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const candidateId = () =>
  uuid("candidate_id")
    .notNull()
    .references(() => candidate.id);

// One approved answer. The id is chosen by the caller before it asks the Gate, because the
// approval's subject is `answer:<id>`. A changed answer is a new row with the next version.
export const bankAnswer = pgTable(
  "bank_answer",
  {
    id: uuid("id").primaryKey(),
    candidateId: candidateId(),
    // An id from packages/profile's CANONICAL_QUESTIONS (`why-this-role`).
    canonicalId: text("canonical_id").notNull(),
    kind: text("kind").notNull(),
    version: integer("version").notNull(),
    shortText: text("short_text").notNull(),
    // A longer variant for forms that allow it; null when there is only one.
    longText: text("long_text"),
    // The Gate decision that let it in: one answer per approval.
    approvalDecisionId: uuid("approval_decision_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("bank_answer_id_candidate_unique").on(t.id, t.candidateId),
    unique("bank_answer_version_unique").on(t.candidateId, t.canonicalId, t.version),
    unique("bank_answer_one_per_approval").on(t.approvalDecisionId),
    foreignKey({
      name: "bank_answer_decision_same_candidate_fk",
      columns: [t.approvalDecisionId, t.candidateId],
      foreignColumns: [approvalDecision.id, approvalDecision.candidateId],
    }),
    check("bank_answer_kind_valid", sql`${t.kind} in (${kindList})`),
    check("bank_answer_canonical_id_format", sql`${t.canonicalId} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check("bank_answer_version_positive", sql`${t.version} >= 1`),
    check("bank_answer_short_not_empty", sql`length(trim(${t.shortText})) > 0`),
    check(
      "bank_answer_long_not_empty",
      sql`${t.longText} is null or length(trim(${t.longText})) > 0`,
    ),
  ],
);

// A story or an atom one answer cites (ADR-0004), exactly one of the two per row.
export const bankAnswerCitation = pgTable(
  "bank_answer_citation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: candidateId(),
    answerId: uuid("answer_id").notNull(),
    storyId: uuid("story_id"),
    atomId: uuid("atom_id"),
  },
  (t) => [
    foreignKey({
      name: "bank_answer_citation_answer_same_candidate_fk",
      columns: [t.answerId, t.candidateId],
      foreignColumns: [bankAnswer.id, bankAnswer.candidateId],
    }),
    foreignKey({
      name: "bank_answer_citation_story_same_candidate_fk",
      columns: [t.storyId, t.candidateId],
      foreignColumns: [story.id, story.candidateId],
    }),
    foreignKey({
      name: "bank_answer_citation_atom_same_candidate_fk",
      columns: [t.atomId, t.candidateId],
      foreignColumns: [experienceAtom.id, experienceAtom.candidateId],
    }),
    check("bank_answer_citation_one_target", sql`num_nonnulls(${t.storyId}, ${t.atomId}) = 1`),
    unique("bank_answer_citation_story_once").on(t.answerId, t.storyId),
    unique("bank_answer_citation_atom_once").on(t.answerId, t.atomId),
  ],
);

// Each application an answer went into (ANS-006). `approved`: the application it was approved
// for; `reused`: a later one. `edited`: Paul changed the draft before approving it (ANS-005).
export const bankAnswerUse = pgTable(
  "bank_answer_use",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: candidateId(),
    answerId: uuid("answer_id").notNull(),
    applicationId: uuid("application_id").notNull(),
    how: text("how").notNull(),
    edited: boolean("edited").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "bank_answer_use_answer_same_candidate_fk",
      columns: [t.answerId, t.candidateId],
      foreignColumns: [bankAnswer.id, bankAnswer.candidateId],
    }),
    foreignKey({
      name: "bank_answer_use_application_same_candidate_fk",
      columns: [t.applicationId, t.candidateId],
      foreignColumns: [application.id, application.candidateId],
    }),
    // Safe to repeat (RES-006): one use per answer and application.
    unique("bank_answer_use_once").on(t.answerId, t.applicationId),
    check("bank_answer_use_how_valid", sql`${t.how} in ('approved', 'reused')`),
    // A reuse is the approved text as it was: only the approval can carry Paul's edits.
    check("bank_answer_use_reuse_unedited", sql`${t.how} = 'approved' or not ${t.edited}`),
  ],
);
