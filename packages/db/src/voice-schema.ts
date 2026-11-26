import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  foreignKey,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { candidate } from "./schema.js";

// Paul's voice profile (NS-185, ANS-007/008). Write it only through voice-write.ts. All three
// tables are append-only (triggers, migration 0053). They hold measurements and short phrases
// from his writing, never a sample, draft or approved text; phrases never go into events or spans.

// One measured version (packages/profile's measureVoice), numbered per candidate from 1.
export const voiceProfile = pgTable(
  "voice_profile",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    version: integer("version").notNull(),
    samples: integer("samples").notNull(),
    words: integer("words").notNull(),
    sentenceWords: doublePrecision("sentence_words").notNull(),
    contractionsPer100: doublePrecision("contractions_per_100").notNull(),
    iPer100: doublePrecision("i_per_100").notNull(),
    wePer100: doublePrecision("we_per_100").notNull(),
    exclamationShare: doublePrecision("exclamation_share").notNull(),
    // Phrases of 2–4 words he used in several samples, most common first.
    phrases: text("phrases").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("voice_profile_version_unique").on(t.candidateId, t.version),
    // Target of voice_review's same-candidate foreign key.
    unique("voice_profile_id_candidate_unique").on(t.id, t.candidateId),
    check("voice_profile_version_positive", sql`${t.version} >= 1`),
    check("voice_profile_samples_range", sql`${t.samples} between 1 and 100`),
    check("voice_profile_words_valid", sql`${t.words} >= 0`),
    check("voice_profile_share_range", sql`${t.exclamationShare} between 0 and 1`),
    check("voice_profile_phrases_count", sql`coalesce(array_length(${t.phrases}, 1), 0) <= 50`),
  ],
);

// Paul's review of one version: each of its phrases kept or dropped. The newest review of a
// version is the one that counts.
export const voiceReview = pgTable(
  "voice_review",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    profileId: uuid("profile_id").notNull(),
    kept: text("kept").array().notNull(),
    dropped: text("dropped").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "voice_review_profile_same_candidate_fk",
      columns: [t.profileId, t.candidateId],
      foreignColumns: [voiceProfile.id, voiceProfile.candidateId],
    }),
  ],
);

// One approved answer that differed from its draft: only the phrases Paul deleted (ANS-008).
export const voiceEdit = pgTable(
  "voice_edit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    // What was approved, e.g. `answer:<id>`: one row per approval, so a retried approval can't
    // count one draft twice toward the avoid list (RES-006).
    subject: text("subject").notNull(),
    deleted: text("deleted").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("voice_edit_subject_unique").on(t.candidateId, t.subject),
    check(
      "voice_edit_subject_shape",
      sql`${t.subject} ~ '^[a-z_]+:[A-Za-z0-9_-]+$' and char_length(${t.subject}) <= 160`,
    ),
    check(
      "voice_edit_deleted_count",
      sql`coalesce(array_length(${t.deleted}, 1), 0) between 1 and 200`,
    ),
  ],
);
