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
import { storedFile } from "./file-schema.js";
import { profileSource } from "./profile-schema.js";
import { candidate, job } from "./schema.js";

// Tailored resumes (NS-146, TLR-001/003/005): every version made for a job, append-only
// (migration trigger), written only through tailor-write.ts. A job has at most one application
// (application_one_per_job), so versions are keyed by job. The resume, validation and score hold
// Paul's resume lines and the job's requirements: they stay in this table, never in an event.
export const tailoredResume = pgTable(
  "tailored_resume",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    jobId: uuid("job_id").notNull(),
    // 1, 2, … per job; the newest is the highest.
    version: integer("version").notNull(),
    // The resume import the master came from.
    profileSourceId: uuid("profile_source_id").notNull(),
    // The TailoredResume (packages/profile), the validator result and the pre-send score.
    resume: jsonb("resume").$type<Record<string, unknown>>().notNull(),
    validation: jsonb("validation").$type<Record<string, unknown>>().notNull(),
    score: jsonb("score").$type<Record<string, unknown>>().notNull(),
    // Added skills Paul turned off (TLR-003's toggles), lowercased and sorted.
    droppedSkills: text("dropped_skills").array().notNull(),
    // SHA-256 of import, resume, toggles and score: saving what the newest version holds stores nothing.
    contentSha256: text("content_sha256").notNull(),
    // The rendered PDF of this version (NS-227), in stored_file; null on versions made before it.
    pdfSha256: text("pdf_sha256"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("tailored_resume_version_unique").on(t.candidateId, t.jobId, t.version),
    check("tailored_resume_version_positive", sql`${t.version} >= 1`),
    check("tailored_resume_sha_format", sql`${t.contentSha256} ~ '^[0-9a-f]{64}$'`),
    foreignKey({
      name: "tailored_resume_job_same_candidate_fk",
      columns: [t.jobId, t.candidateId],
      foreignColumns: [job.id, job.candidateId],
    }),
    foreignKey({
      name: "tailored_resume_source_same_candidate_fk",
      columns: [t.profileSourceId, t.candidateId],
      foreignColumns: [profileSource.id, profileSource.candidateId],
    }),
    foreignKey({
      name: "tailored_resume_pdf_same_candidate_fk",
      columns: [t.candidateId, t.pdfSha256],
      foreignColumns: [storedFile.candidateId, storedFile.sha256],
    }),
  ],
);
