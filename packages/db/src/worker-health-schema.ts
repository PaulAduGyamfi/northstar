import { sql } from "drizzle-orm";
import { boolean, check, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { candidate } from "./schema.js";

// The worker process's heartbeats (NS-225 slice 3, RES-013): one row per candidate and queue,
// overwritten every 30 s while that pool runs, so Health can show a pool that stopped. State, not
// history (like dependency_breaker): no trigger, the newest beat is all that matters. Written only
// through worker-health-write.ts. Queue names and times only.
export const workerHeartbeat = pgTable(
  "worker_heartbeat",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidate.id),
    queue: text("queue").notNull(),
    // False when the pool is turned off in the worker's settings (WORKER_APPLY_BROWSER).
    enabled: boolean("enabled").notNull(),
    // When this run of the worker process started.
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    // The database's clock at the last beat.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("worker_heartbeat_one_per_queue").on(t.candidateId, t.queue),
    // Only the queues that exist (apps/worker src/queues.ts).
    check("worker_heartbeat_queue_known", sql`${t.queue} in ('pipeline', 'apply-browser')`),
  ],
);
