import { bigint, boolean, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { candidate } from "./schema.js";

// The mail poll's cursor (NS-247 slice 2, #293): where `pollNewMail` resumes, so a restart neither
// skips mail nor reads it all again. One row per move, the newest current. Append-only (migration
// trigger), written only through mail-poll-write.ts.
export const mailPollCursor = pgTable(
  "mail_poll_cursor",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Orders moves even when two land in the same instant.
    position: bigint("position", { mode: "bigint" }).notNull().generatedAlwaysAsIdentity(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    // The next run's `since`: the receive time of the last message handled.
    since: timestamp("since", { withTimezone: true }).notNull(),
    // The next run's `overlap`: false right after a truncated run (see pollNewMail).
    overlap: boolean("overlap").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("mail_poll_cursor_position_unique").on(t.position)],
);
