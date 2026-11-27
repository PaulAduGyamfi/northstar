import type { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { workerHeartbeat } from "./worker-health-schema.js";

// The worker's heartbeats (NS-225 slice 3): the one write path and its reader. Times come from
// the database's clock, so a worker running on a skewed clock can't look alive or dead.

export const WORKER_QUEUES = ["pipeline", "apply-browser"] as const;
export type WorkerQueue = (typeof WORKER_QUEUES)[number];

// One beat for one pool: creates its row, or moves its last-seen time to now.
export async function recordWorkerHeartbeat(
  db: Db,
  candidateId: CandidateId,
  beat: { queue: WorkerQueue; enabled: boolean; startedAt: Date },
): Promise<void> {
  await db
    .insert(workerHeartbeat)
    .values({
      candidateId,
      queue: beat.queue,
      enabled: beat.enabled,
      startedAt: beat.startedAt,
      lastSeenAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: [workerHeartbeat.candidateId, workerHeartbeat.queue],
      set: { enabled: beat.enabled, startedAt: beat.startedAt, lastSeenAt: sql`now()` },
    });
}

// Each pool's last beat, as whole seconds before the database's now (for systemHealth).
export async function readWorkerHeartbeats(
  db: Db,
  candidateId: CandidateId,
): Promise<{ queue: string; enabled: boolean; secondsSinceSeen: number }[]> {
  const rows = await db
    .select({
      queue: workerHeartbeat.queue,
      enabled: workerHeartbeat.enabled,
      seconds: sql<string>`floor(extract(epoch from now() - ${workerHeartbeat.lastSeenAt}))`,
    })
    .from(workerHeartbeat)
    .where(eq(workerHeartbeat.candidateId, candidateId))
    .orderBy(workerHeartbeat.queue);
  // A clock that moved back reads as just seen, never as negative.
  return rows.map((r) => ({
    queue: r.queue,
    enabled: r.enabled,
    secondsSinceSeen: Math.max(0, Number(r.seconds)),
  }));
}
