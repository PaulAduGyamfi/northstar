import { ADJUSTABLE_REASONS } from "@northstar/domain";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { candidate } from "./schema.js";

// The adjustable reasons as SQL literals, for the CHECK: constants only, never input.
const REASON_LIST = sql.raw(ADJUSTABLE_REASONS.map((r) => `'${r}'`).join(", "));

// The point adjustments recruiter grading learned from Paul's regrades (NS-238 item 3 slice 2,
// REC-003): one version per change, the newest current. Two parallel arrays (a reason and its
// adjustment at the same index) so the database itself can hold each reason to the listed ones and
// each adjustment to -2…+2. Codes and numbers only. Append-only (migration trigger), written only
// through recruiter-weight-write.ts.
export const recruiterWeight = pgTable(
  "recruiter_weight",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Orders versions by insert, even when two land in the same instant.
    position: bigint("position", { mode: "bigint" }).notNull().generatedAlwaysAsIdentity(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    reasons: text("reasons").array().notNull(),
    adjustments: integer("adjustments").array().notNull(),
    // How many of Paul's regrades the version was learned from.
    regrades: integer("regrades").notNull(),
    learnedAt: timestamp("learned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("recruiter_weight_position_unique").on(t.position),
    // The newest version is read by candidate.
    index("recruiter_weight_candidate").on(t.candidateId, t.position),
    check(
      "recruiter_weight_reasons_listed",
      sql`array_position(${t.reasons}, null) is null and ${t.reasons} <@ array[${REASON_LIST}]::text[]`,
    ),
    // One adjustment per entry, each a whole number from -2 to 2 and never 0 (no entry instead).
    check(
      "recruiter_weight_adjustments_bounded",
      sql`cardinality(${t.adjustments}) = cardinality(${t.reasons}) and array_position(${t.adjustments}, null) is null and ${t.adjustments} <@ array[-2, -1, 1, 2]`,
    ),
    check("recruiter_weight_regrades_count", sql`${t.regrades} >= 0`),
  ],
);
