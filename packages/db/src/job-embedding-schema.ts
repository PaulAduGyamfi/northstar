import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { candidate, job } from "./schema.js";

// Job embeddings and duplicate suggestions (NS-129 slice 2, SRC-006, ADR-0033). Both tables are
// append-only (migration trigger) and written only through job-embedding-write.ts. An embedding
// is of employer text only (`embeddingText` in packages/sources), and a suggestion never merges,
// edits or deletes a job: findDuplicate stays the only merge.

// The one model and size stored. A new model is a migration, so vectors are never mixed.
export const STORED_EMBED_MODEL = "text-embedding-3-small";
export const STORED_EMBED_DIMENSIONS = 512;

// One vector per job, model and text. The newest per job and model is current: an edited title or
// requirement is a new text, so a new row, and the old one stays as history.
export const jobEmbedding = pgTable(
  "job_embedding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Orders rows even when two land in the same instant.
    position: bigint("position", { mode: "bigint" }).notNull().generatedAlwaysAsIdentity(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    jobId: uuid("job_id").notNull(),
    model: text("model").notNull(),
    dimensions: integer("dimensions").notNull(),
    // SHA-256 of the exact text sent, never the text itself.
    textSha256: text("text_sha256").notNull(),
    embedding: vector("embedding", { dimensions: STORED_EMBED_DIMENSIONS }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("job_embedding_position_unique").on(t.position),
    // The same text embedded twice stores nothing new.
    unique("job_embedding_job_model_text_unique").on(t.jobId, t.model, t.textSha256),
    // The job must be this candidate's own.
    foreignKey({
      name: "job_embedding_job_same_candidate_fk",
      columns: [t.jobId, t.candidateId],
      foreignColumns: [job.id, job.candidateId],
    }),
    check("job_embedding_model_valid", sql`${t.model} = 'text-embedding-3-small'`),
    check("job_embedding_dimensions_valid", sql`${t.dimensions} = 512`),
    check("job_embedding_text_sha256_shape", sql`${t.textSha256} ~ '^[0-9a-f]{64}$'`),
    // The current row per job and model is read by position.
    index("job_embedding_job_model_position_idx").on(t.candidateId, t.jobId, t.model, t.position),
  ],
);

// One suggestion per pair of the candidate's own jobs and model: "these two look like the same
// role". The pair is stored in one order (job_a < job_b), so a pair can't be suggested twice.
export const jobDuplicateSuggestion = pgTable(
  "job_duplicate_suggestion",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    position: bigint("position", { mode: "bigint" }).notNull().generatedAlwaysAsIdentity(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    jobA: uuid("job_a").notNull(),
    jobB: uuid("job_b").notNull(),
    model: text("model").notNull(),
    // Cosine similarity of the two current vectors when suggested.
    similarity: real("similarity").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("job_duplicate_suggestion_position_unique").on(t.position),
    unique("job_duplicate_suggestion_pair_unique").on(t.candidateId, t.jobA, t.jobB, t.model),
    foreignKey({
      name: "job_duplicate_suggestion_job_a_same_candidate_fk",
      columns: [t.jobA, t.candidateId],
      foreignColumns: [job.id, job.candidateId],
    }),
    foreignKey({
      name: "job_duplicate_suggestion_job_b_same_candidate_fk",
      columns: [t.jobB, t.candidateId],
      foreignColumns: [job.id, job.candidateId],
    }),
    check("job_duplicate_suggestion_pair_ordered", sql`${t.jobA} < ${t.jobB}`),
    check("job_duplicate_suggestion_model_valid", sql`${t.model} = 'text-embedding-3-small'`),
    check(
      "job_duplicate_suggestion_similarity_range",
      sql`${t.similarity} >= 0 AND ${t.similarity} <= 1`,
    ),
  ],
);
