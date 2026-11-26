import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { candidate, job } from "./schema.js";

// A job's application form (NS-227, APPLY-001): the questions its ATS publishes, as read by
// packages/sources. Append-only (migration trigger), written only through job-form-write.ts: a
// form that changes is a new row, the newest per job is current. Labels and choices are the
// employer's text, compared by plain code only, never sent to a model.
export type JobFormQuestion = {
  // The form's own field name: the key the Apply Gateway fills.
  fieldName: string;
  label: string;
  required: boolean;
  kind: "text" | "textarea" | "select" | "multi_select" | "file" | "hidden";
  // The allowed values of a select kind (label shown, value submitted); null otherwise.
  choices: { label: string; value: string }[] | null;
  // The question it belongs to: fields with the same group are alternatives (a resume's file
  // and its paste-in text).
  group: number;
};

export const jobForm = pgTable(
  "job_form",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Orders forms even when two land in the same instant.
    position: bigint("position", { mode: "bigint" }).notNull().generatedAlwaysAsIdentity(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    jobId: uuid("job_id").notNull(),
    ats: text("ats").notNull(),
    // SHA-256 of the questions' canonical JSON: compared with the job's newest row, so a form is
    // stored again when it comes back after a change (A, B, A: the newest A is current).
    sha256: text("sha256").notNull(),
    questions: jsonb("questions").$type<JobFormQuestion[]>().notNull(),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("job_form_position_unique").on(t.position),
    check("job_form_sha256_shape", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check("job_form_questions_array", sql`jsonb_typeof(${t.questions}) = 'array'`),
    foreignKey({
      name: "job_form_job_same_candidate_fk",
      columns: [t.jobId, t.candidateId],
      foreignColumns: [job.id, job.candidateId],
    }),
  ],
);
