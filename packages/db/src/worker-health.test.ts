import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { readSystemHealth } from "./health-read.js";
import { createTestDb, seedApplication } from "./test/pglite.js";
import { workerHeartbeat } from "./worker-health-schema.js";
import { readWorkerHeartbeats, recordWorkerHeartbeat } from "./worker-health-write.js";

// The worker's heartbeats (NS-225 slice 3): one row per queue, on the database's clock, read into
// the health model so a stopped pool shows on Health.

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
const STARTED = new Date("2026-11-27T18:00:00Z");

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  candidateId = CandidateId.parse((await seedApplication(db, "queued")).candidateId);
});
afterEach(() => close());

// Moves a queue's last beat back by `seconds`, as if the pool had gone quiet.
async function quietFor(queue: string, seconds: number): Promise<void> {
  await db
    .update(workerHeartbeat)
    .set({ lastSeenAt: sql`now() - make_interval(secs => ${seconds})` })
    .where(eq(workerHeartbeat.queue, queue));
}

describe("recordWorkerHeartbeat", () => {
  it("keeps one row per queue, moving its last beat to now", async () => {
    await recordWorkerHeartbeat(db, candidateId, {
      queue: "pipeline",
      enabled: true,
      startedAt: STARTED,
    });
    await quietFor("pipeline", 120);
    await recordWorkerHeartbeat(db, candidateId, {
      queue: "pipeline",
      enabled: true,
      startedAt: STARTED,
    });
    const rows = await db.select().from(workerHeartbeat);
    expect([rows.length, await readWorkerHeartbeats(db, candidateId)]).toEqual([
      1,
      [{ queue: "pipeline", enabled: true, secondsSinceSeen: 0 }],
    ]);
  });

  it("refuses a queue that doesn't exist", async () => {
    await expect(
      recordWorkerHeartbeat(db, candidateId, {
        queue: "sourcing" as never,
        enabled: true,
        startedAt: STARTED,
      }),
    ).rejects.toThrow();
  });

  it("reads only the candidate's own pools", async () => {
    const other = CandidateId.parse((await seedApplication(db, "queued")).candidateId);
    await recordWorkerHeartbeat(db, other, {
      queue: "pipeline",
      enabled: true,
      startedAt: STARTED,
    });
    expect(await readWorkerHeartbeats(db, candidateId)).toEqual([]);
  });
});

describe("readSystemHealth with worker pools", () => {
  it("shows a pool that went quiet as down and one turned off as off", async () => {
    await recordWorkerHeartbeat(db, candidateId, {
      queue: "pipeline",
      enabled: true,
      startedAt: STARTED,
    });
    await recordWorkerHeartbeat(db, candidateId, {
      queue: "apply-browser",
      enabled: false,
      startedAt: STARTED,
    });
    await quietFor("pipeline", 600);
    const workers = (await readSystemHealth(db, candidateId)).subsystems.filter(
      (s) => s.kind === "worker",
    );
    expect(workers.map((w) => [w.subsystem, w.health, w.reason])).toEqual([
      ["worker:pipeline", "down", "Not running: last seen 10 minutes ago"],
      ["worker:apply-browser", "healthy", "Turned off in the worker's settings"],
    ]);
  });
});
