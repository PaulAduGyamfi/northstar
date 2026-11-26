import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { candidate, job } from "./schema.js";

// Posting liveness (NS-173 slice 2, SRC-010): each re-check of a job's posting that got an
// answer, append-only (migration trigger), written only through liveness-write.ts. The newest row
// per job is its state; no row means never checked. An unavailable board stores nothing.
export const POSTING_OUTCOMES = ["open", "closed"] as const;

export const postingCheck = pgTable(
  "posting_check",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Orders checks even when two land in the same instant.
    position: bigint("position", { mode: "bigint" }).notNull().generatedAlwaysAsIdentity(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    jobId: uuid("job_id").notNull(),
    outcome: text("outcome").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("posting_check_position_unique").on(t.position),
    check("posting_check_outcome_valid", sql`${t.outcome} in ('open', 'closed')`),
    foreignKey({
      name: "posting_check_job_same_candidate_fk",
      columns: [t.jobId, t.candidateId],
      foreignColumns: [job.id, job.candidateId],
    }),
  ],
);
