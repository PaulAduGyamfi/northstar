import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { experienceAtom } from "./profile-schema.js";
import { candidate } from "./schema.js";

// The story bank (CPG-003, ADR-0004, NS-111): STAR stories told in Paul's own words, each built
// from one interview about one experience atom. Every row names its candidate (Q-02), and links
// go through same-candidate composite keys like the profile graph.

// The competency tags a story may carry (CPG-003). The database CHECK below uses the same list,
// so a tag outside it can't be stored by any writer.
export const COMPETENCIES = [
  "leadership",
  "conflict",
  "ambiguity",
  "scale",
  "failure",
  "ownership",
  "collaboration",
  "technical-depth",
  "customer-impact",
  "learning",
] as const;
export type Competency = (typeof COMPETENCIES)[number];

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const candidateId = () =>
  uuid("candidate_id")
    .notNull()
    .references(() => candidate.id);

// A foreign key to experience_atom through (atom_id, candidate_id): never another candidate's atom.
const atomFk = (name: string, t: { atomId: AnyPgColumn; candidateId: AnyPgColumn }) =>
  foreignKey({
    name,
    columns: [t.atomId, t.candidateId],
    foreignColumns: [experienceAtom.id, experienceAtom.candidateId],
  });

// One interview session about one atom. `open` until a story is approved (`drafted`) or Paul
// skips it (`abandoned`). At most one open session per atom, so a rerun resumes it.
export const storyInterview = pgTable(
  "story_interview",
  {
    id: id(),
    candidateId: candidateId(),
    atomId: uuid("atom_id").notNull(),
    status: text("status").notNull().default("open"),
    createdAt: createdAt(),
  },
  (t) => [
    atomFk("story_interview_atom_same_candidate_fk", t),
    unique("story_interview_id_candidate_unique").on(t.id, t.candidateId),
    check("story_interview_status_valid", sql`${t.status} in ('open', 'drafted', 'abandoned')`),
    uniqueIndex("story_interview_one_open_per_atom")
      .on(t.candidateId, t.atomId)
      .where(sql`${t.status} = 'open'`),
  ],
);

// One question and Paul's answer, in order. These are his own words: they stay in this table and
// never go into events, spans, logs or eval fixtures. One row per position (RES-006).
export const storyAnswer = pgTable(
  "story_answer",
  {
    id: id(),
    candidateId: candidateId(),
    interviewId: uuid("interview_id").notNull(),
    position: integer("position").notNull(),
    question: text("question").notNull(),
    // May be empty: the optional last question can be skipped, and the empty row records that
    // it was asked, so a resumed session doesn't ask it again.
    answer: text("answer").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "story_answer_interview_same_candidate_fk",
      columns: [t.interviewId, t.candidateId],
      foreignColumns: [storyInterview.id, storyInterview.candidateId],
    }),
    unique("story_answer_one_per_position").on(t.interviewId, t.position),
    check("story_answer_position_valid", sql`${t.position} >= 0`),
  ],
);

// A STAR story. Once approved it is locked by a trigger (migration 0010): generators may cite it,
// never rewrite it. It must cite at least one atom (a deferred constraint trigger, 0010).
export const story = pgTable(
  "story",
  {
    id: id(),
    candidateId: candidateId(),
    interviewId: uuid("interview_id").notNull(),
    title: text("title").notNull(),
    situation: text("situation").notNull(),
    task: text("task").notNull(),
    action: text("action").notNull(),
    result: text("result").notNull(),
    competencies: text("competencies").array().notNull(),
    status: text("status").notNull().default("draft"),
    // NFR-AIQ-003: which prompt and model drafted it.
    promptVersion: integer("prompt_version").notNull(),
    model: text("model").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "story_interview_same_candidate_fk",
      columns: [t.interviewId, t.candidateId],
      foreignColumns: [storyInterview.id, storyInterview.candidateId],
    }),
    unique("story_id_candidate_unique").on(t.id, t.candidateId),
    check("story_status_valid", sql`${t.status} in ('draft', 'approved', 'rejected')`),
    // approved_at is set exactly when the story is approved.
    check(
      "story_approved_at_matches_status",
      sql`(${t.status} = 'approved') = (${t.approvedAt} is not null)`,
    ),
    // 1 to 3 tags, all from COMPETENCIES.
    check(
      "story_competencies_valid",
      sql`cardinality(${t.competencies}) between 1 and 3 and ${t.competencies} <@ array[${sql.raw(
        COMPETENCIES.map((c) => `'${c}'`).join(", "),
      )}]::text[]`,
    ),
    check(
      "story_parts_not_empty",
      sql`length(trim(${t.title})) > 0 and length(trim(${t.situation})) > 0 and length(trim(${t.task})) > 0 and length(trim(${t.action})) > 0 and length(trim(${t.result})) > 0`,
    ),
  ],
);

// The atoms a story cites (ADR-0004: stories cite atoms).
export const storyAtom = pgTable(
  "story_atom",
  {
    candidateId: candidateId(),
    storyId: uuid("story_id").notNull(),
    atomId: uuid("atom_id").notNull(),
  },
  (t) => [
    primaryKey({ name: "story_atom_pk", columns: [t.storyId, t.atomId] }),
    foreignKey({
      name: "story_atom_story_same_candidate_fk",
      columns: [t.storyId, t.candidateId],
      foreignColumns: [story.id, story.candidateId],
    }),
    atomFk("story_atom_atom_same_candidate_fk", t),
  ],
);
