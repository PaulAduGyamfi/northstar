import { sql } from "drizzle-orm";
import {
  boolean,
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
import { profileSource } from "./profile-schema.js";
import { candidate, job } from "./schema.js";

// Search preferences and fit scores (NS-116, MAT-001…003, SRC-017).

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// One row per version of Paul's search preferences. A change inserts the next version and never
// edits an old one, so scores can name the version they used and history is kept (SRC-018).
// The current preferences are the highest version.
export const searchPreference = pgTable(
  "search_preference",
  {
    id: id(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    version: integer("version").notNull(),
    titles: text("titles").array().notNull().default(sql`'{}'::text[]`),
    seniority: text("seniority").array().notNull().default(sql`'{}'::text[]`),
    locations: text("locations").array().notNull().default(sql`'{}'::text[]`),
    remote: text("remote").array().notNull().default(sql`'{}'::text[]`),
    dealbreakers: text("dealbreakers").array().notNull().default(sql`'{}'::text[]`),
    // Yearly pay in `currency`; null when Paul hasn't set one.
    compFloor: integer("comp_floor"),
    compTarget: integer("comp_target"),
    currency: text("currency").notNull().default("USD"),
    // MAT-003: score >= queue_at is queued, >= suggest_at suggested, anything lower skipped.
    queueAt: integer("queue_at").notNull().default(80),
    suggestAt: integer("suggest_at").notNull().default(60),
    createdAt: createdAt(),
  },
  (t) => [
    unique("search_preference_version_unique").on(t.candidateId, t.version),
    // Target of fit_score's same-candidate foreign key.
    unique("search_preference_id_candidate_unique").on(t.id, t.candidateId),
    check("search_preference_version_positive", sql`${t.version} >= 1`),
    check(
      "search_preference_remote_valid",
      sql`${t.remote} <@ array['onsite', 'hybrid', 'remote']::text[]`,
    ),
    check(
      "search_preference_thresholds",
      sql`${t.suggestAt} between 0 and 100 and ${t.queueAt} between 0 and 100 and ${t.suggestAt} <= ${t.queueAt}`,
    ),
    check(
      "search_preference_comp_order",
      sql`${t.compFloor} is null or ${t.compTarget} is null or ${t.compFloor} <= ${t.compTarget}`,
    ),
    check(
      "search_preference_comp_nonnegative",
      sql`coalesce(${t.compFloor}, 0) >= 0 and coalesce(${t.compTarget}, 0) >= 0`,
    ),
    check("search_preference_currency_format", sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);

export const FIT_BANDS = ["queue", "suggest", "skip"] as const;
const bandList = sql.raw(FIT_BANDS.map((b) => `'${b}'`).join(", "));

// One score of one job. The key is everything the score depends on: the job's scoring fields
// (job_fingerprint), the preference version and the resume import. A new key means a new row;
// the same key twice stores one (safe to repeat). Rows are never updated.
export const fitScore = pgTable(
  "fit_score",
  {
    id: id(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    jobId: uuid("job_id").notNull(),
    preferenceId: uuid("preference_id").notNull(),
    profileSourceId: uuid("profile_source_id").notNull(),
    // sha256 of the job fields scoring reads (packages/sources decides which).
    jobFingerprint: text("job_fingerprint").notNull(),
    score: integer("score").notNull(),
    band: text("band").notNull(),
    // A fixed code (dealbreaker, below_comp_floor, below_threshold:<component>...), never text
    // from a posting.
    reason: text("reason").notNull(),
    stretch: boolean("stretch").notNull(),
    // Each component 0–1, or null when the posting doesn't tell (MAT-001).
    components: jsonb("components").$type<Record<string, number | null>>().notNull(),
    // Matched requirements with the atom that meets each, unmatched ones, and the preference
    // checks (MAT-002). Requirements are posting text; atoms appear by id and matched term only.
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    method: text("method").notNull(),
    scoredAt: timestamp("scored_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("fit_score_key_unique").on(
      t.candidateId,
      t.jobId,
      t.preferenceId,
      t.profileSourceId,
      t.jobFingerprint,
    ),
    foreignKey({
      name: "fit_score_job_same_candidate_fk",
      columns: [t.jobId, t.candidateId],
      foreignColumns: [job.id, job.candidateId],
    }),
    foreignKey({
      name: "fit_score_preference_same_candidate_fk",
      columns: [t.preferenceId, t.candidateId],
      foreignColumns: [searchPreference.id, searchPreference.candidateId],
    }),
    foreignKey({
      name: "fit_score_profile_source_same_candidate_fk",
      columns: [t.profileSourceId, t.candidateId],
      foreignColumns: [profileSource.id, profileSource.candidateId],
    }),
    check("fit_score_range", sql`${t.score} between 0 and 100`),
    check("fit_score_band_valid", sql`${t.band} in (${bandList})`),
    check("fit_score_method_valid", sql`${t.method} in ('rules')`),
    check("fit_score_fingerprint_format", sql`${t.jobFingerprint} ~ '^[0-9a-f]{64}$'`),
  ],
);
