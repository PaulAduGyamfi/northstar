import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { candidate } from "./schema.js";

// The growth tracker's storage (NS-210, GRW-001…004). All append-only (migration 0062); write
// only through growth-write.ts. Track keys, names and next actions are Paul's words: never in
// events, spans or logs.

const candidateRef = () =>
  uuid("candidate_id")
    .notNull()
    .references(() => candidate.id);

// One row per stored tracks file; the newest version is current.
export const growthTrackSet = pgTable(
  "growth_track_set",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: candidateRef(),
    version: integer("version").notNull(),
    contentSha256: text("content_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("growth_track_set_id_candidate_unique").on(t.id, t.candidateId),
    unique("growth_track_set_version_unique").on(t.candidateId, t.version),
    check("growth_track_set_version_positive", sql`${t.version} >= 1`),
    check("growth_track_set_sha256_format", sql`${t.contentSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const growthTrack = pgTable(
  "growth_track",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: candidateRef(),
    setId: uuid("set_id").notNull(),
    position: integer("position").notNull(),
    // Paul's short id for the track, stable across versions of the file.
    key: text("key").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    status: text("status").notNull(),
    priority: integer("priority").notNull(),
    targetDate: date("target_date"),
    untouchedDays: integer("untouched_days").notNull(),
    nextTitle: text("next_title"),
    nextMinutes: integer("next_minutes"),
    // GRW-001 (NS-232): what the track is for and when it is finished, in Paul's words.
    goal: text("goal"),
    doneWhen: text("done_when"),
  },
  (t) => [
    unique("growth_track_key_unique").on(t.setId, t.key),
    // For growth_milestone's same-candidate foreign key.
    unique("growth_track_id_candidate_unique").on(t.id, t.candidateId),
    check(
      "growth_track_goal_shape",
      sql`${t.goal} is null or (length(trim(${t.goal})) between 1 and 300 and ${t.goal} !~ '[[:cntrl:]]')`,
    ),
    check(
      "growth_track_done_when_shape",
      sql`${t.doneWhen} is null or (length(trim(${t.doneWhen})) between 1 and 300 and ${t.doneWhen} !~ '[[:cntrl:]]')`,
    ),
    foreignKey({
      name: "growth_track_set_same_candidate_fk",
      columns: [t.setId, t.candidateId],
      foreignColumns: [growthTrackSet.id, growthTrackSet.candidateId],
    }),
    check("growth_track_key_format", sql`${t.key} ~ '^[a-z0-9][a-z0-9-]{0,39}$'`),
    check(
      "growth_track_name_shape",
      sql`length(trim(${t.name})) between 1 and 120 and ${t.name} !~ '[[:cntrl:]]'`,
    ),
    check("growth_track_type_valid", sql`${t.type} in ('project', 'course', 'cert', 'skill')`),
    check(
      "growth_track_status_valid",
      sql`${t.status} in ('active', 'paused', 'backlogged', 'done')`,
    ),
    check("growth_track_priority_range", sql`${t.priority} between 1 and 5`),
    check("growth_track_untouched_range", sql`${t.untouchedDays} between 1 and 365`),
    // A next action has both a title and minutes, or neither.
    check(
      "growth_track_next_title_shape",
      sql`${t.nextTitle} is null or (length(trim(${t.nextTitle})) between 1 and 200 and ${t.nextTitle} !~ '[[:cntrl:]]')`,
    ),
    check(
      "growth_track_next_pair",
      sql`(${t.nextTitle} is null) = (${t.nextMinutes} is null) and (${t.nextMinutes} is null or ${t.nextMinutes} >= 1)`,
    ),
  ],
);

// A track's milestones in order (GRW-002, NS-232), stored with its version: Paul's words.
export const growthMilestone = pgTable(
  "growth_milestone",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: candidateRef(),
    trackId: uuid("track_id").notNull(),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    doneOn: date("done_on"),
  },
  (t) => [
    unique("growth_milestone_position_unique").on(t.trackId, t.position),
    foreignKey({
      name: "growth_milestone_track_same_candidate_fk",
      columns: [t.trackId, t.candidateId],
      foreignColumns: [growthTrack.id, growthTrack.candidateId],
    }),
    check("growth_milestone_position_range", sql`${t.position} between 0 and 19`),
    check(
      "growth_milestone_title_shape",
      sql`length(trim(${t.title})) between 1 and 200 and ${t.title} !~ '[[:cntrl:]]'`,
    ),
  ],
);

// Each time Paul worked on a track; a track's last touch is its newest row.
export const growthTouch = pgTable(
  "growth_touch",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: candidateRef(),
    // By key, not row: a key names the same track across versions of the file, so its touches
    // carry over when Paul edits the file.
    trackKey: text("track_key").notNull(),
    touchedAt: timestamp("touched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("growth_touch_key_format", sql`${t.trackKey} ~ '^[a-z0-9][a-z0-9-]{0,39}$'`)],
);

// The planner's settings; the newest row is current, none means the defaults (Q-09).
export const growthSettings = pgTable(
  "growth_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: candidateRef(),
    weeklyMinutes: integer("weekly_minutes").notNull(),
    wipLimit: integer("wip_limit").notNull(),
    blockMinutes: integer("block_minutes").notNull(),
    maintenanceMinutes: integer("maintenance_minutes").notNull(),
    minFocusSessions: integer("min_focus_sessions").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The same ranges as parsePlanSettings (packages/domain).
    check(
      "growth_settings_ranges",
      sql`${t.weeklyMinutes} between 0 and 10080 and ${t.wipLimit} between 1 and 10 and ${t.blockMinutes} between 15 and 90 and ${t.maintenanceMinutes} between 15 and 90 and ${t.minFocusSessions} between 1 and 7`,
    ),
  ],
);

// One plan per week (Monday, UTC) per candidate, as planWeek returned it: track keys and minutes.
export const growthPlan = pgTable(
  "growth_plan",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: candidateRef(),
    weekStart: date("week_start").notNull(),
    trackSetVersion: integer("track_set_version").notNull(),
    plan: jsonb("plan").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("growth_plan_week_unique").on(t.candidateId, t.weekStart),
    check("growth_plan_monday", sql`extract(isodow from ${t.weekStart}) = 1`),
  ],
);

// GRW-005's check-ins (NS-214): a session Paul logged against a track, by key like growth_touch.
// No free text. The client's idempotency key makes a double submit store one row.
export const growthCheckIn = pgTable(
  "growth_check_in",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: candidateRef(),
    trackKey: text("track_key").notNull(),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }).notNull().defaultNow(),
    minutes: integer("minutes").notNull(),
    // A course's completion, when Paul knows it.
    percent: real("percent"),
    idempotencyKey: text("idempotency_key").notNull(),
  },
  (t) => [
    unique("growth_check_in_idempotency_unique").on(t.candidateId, t.idempotencyKey),
    check("growth_check_in_key_format", sql`${t.trackKey} ~ '^[a-z0-9][a-z0-9-]{0,39}$'`),
    check("growth_check_in_minutes_range", sql`${t.minutes} between 1 and 600`),
    check(
      "growth_check_in_percent_range",
      sql`${t.percent} is null or (${t.percent} >= 0 and ${t.percent} <= 100)`,
    ),
    check(
      "growth_check_in_idempotency_shape",
      sql`${t.idempotencyKey} ~ '^[A-Za-z0-9_:-]{8,100}$'`,
    ),
  ],
);

// GRW-007's review of one week (NS-214), stored once: what moved (key, minutes, planned minutes)
// and the planned track keys with no check-in.
export const growthReview = pgTable(
  "growth_review",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: candidateRef(),
    weekStart: date("week_start").notNull(),
    review: jsonb("review").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("growth_review_week_unique").on(t.candidateId, t.weekStart),
    check("growth_review_monday", sql`extract(isodow from ${t.weekStart}) = 1`),
  ],
);
