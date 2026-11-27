import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { candidate } from "./schema.js";

// Paul's fresh-job alert settings (NS-199 slice 2, SRC-015/017): one row per change, the newest
// current. A null field means "use the ALERT_* default", so .env stays the default. Append-only
// (migration trigger), written only through alert-setting-write.ts. Kept apart from
// search_preference because that table's version is in every Fit Score's key: a quiet-hours change
// there would re-score every ready job.
export const alertSetting = pgTable(
  "alert_setting",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Orders changes even when two land in the same instant.
    position: bigint("position", { mode: "bigint" }).notNull().generatedAlwaysAsIdentity(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    // Null: the default. 'off': no quiet hours. 'range': quiet from quiet_start to quiet_end.
    quietKind: text("quiet_kind"),
    // Minutes after local midnight; set only for a range.
    quietStart: integer("quiet_start"),
    quietEnd: integer("quiet_end"),
    // An IANA zone name; null for the default.
    timeZone: text("time_zone"),
    // Whether tier-1 boards may alert inside quiet hours; null for the default.
    tier1InQuietHours: boolean("tier1_in_quiet_hours"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("alert_setting_position_unique").on(t.position),
    // NULL-safe throughout: a CHECK that evaluates to NULL lets the row in.
    check(
      "alert_setting_quiet_shape",
      sql`(${t.quietKind} IS NULL AND ${t.quietStart} IS NULL AND ${t.quietEnd} IS NULL)
        OR (${t.quietKind} IS NOT DISTINCT FROM 'off' AND ${t.quietStart} IS NULL AND ${t.quietEnd} IS NULL)
        OR (${t.quietKind} IS NOT DISTINCT FROM 'range' AND ${t.quietStart} IS NOT NULL AND ${t.quietEnd} IS NOT NULL
            AND ${t.quietStart} BETWEEN 0 AND 1439
            AND ${t.quietEnd} BETWEEN 0 AND 1439 AND ${t.quietStart} <> ${t.quietEnd})`,
    ),
    // A zone name's shape only (Area/City); the code checks it is one the runtime knows.
    check(
      "alert_setting_time_zone_shape",
      sql`${t.timeZone} IS NULL OR ${t.timeZone} ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$'`,
    ),
  ],
);
