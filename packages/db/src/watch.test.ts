import { CandidateId } from "@northstar/domain";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { candidate, companyWatch, domainEvent } from "./schema.js";
import { createTestDb, sqlState } from "./test/pglite.js";
import {
  addWatch,
  dueWatches,
  listWatches,
  removeWatch,
  retryWatch,
  savePollResult,
  type WatchInput,
} from "./watch-write.js";

const CHECK_VIOLATION = "23514";
const NOW = new Date("2026-11-25T12:00:00Z");
const later = (min: number) => new Date(NOW.getTime() + min * 60_000);

// Synthetic boards only (invented companies).
const globex: WatchInput = {
  ats: "greenhouse",
  board: "globex",
  url: "https://boards.greenhouse.io/globex",
  tier: 1,
};

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  candidateId = CandidateId.parse(c.id);
});

afterEach(async () => {
  await close();
});

const events = () =>
  db
    .select()
    .from(domainEvent)
    .where(eq(domainEvent.candidateId, candidateId))
    .orderBy(domainEvent.position);

describe("watchlist", () => {
  it("adds a board once; adding it again reports it exists", async () => {
    const first = await addWatch(db, { candidateId, now: NOW, watch: globex });
    expect(first.status).toBe("added");
    expect(await addWatch(db, { candidateId, now: NOW, watch: globex })).toEqual({
      status: "exists",
      id: first.id,
    });
    expect(await db.select().from(companyWatch)).toHaveLength(1);
  });

  it("a new board is due at once", async () => {
    await addWatch(db, { candidateId, now: NOW, watch: globex });
    expect((await dueWatches(db, candidateId, NOW)).map((w) => w.board)).toEqual(["globex"]);
  });

  it("only boards whose next poll has passed are due, quarantined ones never", async () => {
    const a = await addWatch(db, { candidateId, now: NOW, watch: globex });
    const b = await addWatch(db, { candidateId, now: NOW, watch: { ...globex, board: "initech" } });
    await savePollResult(db, {
      candidateId,
      watchId: a.id,
      now: NOW,
      result: { outcome: "ok", seen: 3, added: 1, failed: 0, errorName: null },
      next: { nextPollAt: later(10), status: "ok", consecutiveFailures: 0 },
    });
    await savePollResult(db, {
      candidateId,
      watchId: b.id,
      now: NOW,
      result: { outcome: "failed", seen: 0, added: 0, failed: 0, errorName: "TimeoutError" },
      next: { nextPollAt: later(1), status: "quarantined", consecutiveFailures: 5 },
    });
    expect(await dueWatches(db, candidateId, later(5))).toEqual([]);
    expect((await dueWatches(db, candidateId, later(10))).map((w) => w.board)).toEqual(["globex"]);
  });

  it("records a poll's counts and error name, and a counts-only event", async () => {
    const { id } = await addWatch(db, { candidateId, now: NOW, watch: globex });
    await savePollResult(db, {
      candidateId,
      watchId: id,
      now: NOW,
      result: { outcome: "ok", seen: 12, added: 2, failed: 0, errorName: null },
      next: { nextPollAt: later(10), status: "ok", consecutiveFailures: 0 },
    });
    const [row] = await listWatches(db, candidateId);
    expect(row).toMatchObject({ jobsFound: 2, lastSuccessAt: NOW, consecutiveFailures: 0 });
    const [, event] = await events();
    expect(event?.type).toBe("source.polled");
    expect(event?.payload).toEqual({
      ats: "greenhouse",
      outcome: "ok",
      seen: 12,
      added: 2,
      failed: 0,
      tier: 1,
    });
    expect(JSON.stringify(event?.payload)).not.toContain("globex");
  });

  it("records a quarantine as its own event", async () => {
    const { id } = await addWatch(db, { candidateId, now: NOW, watch: globex });
    await savePollResult(db, {
      candidateId,
      watchId: id,
      now: NOW,
      result: { outcome: "failed", seen: 0, added: 0, failed: 0, errorName: "FetchRefused" },
      next: { nextPollAt: later(360), status: "quarantined", consecutiveFailures: 5 },
    });
    expect((await events()).map((e) => e.type)).toEqual([
      "source.watched",
      "source.polled",
      "source.quarantined",
    ]);
    expect((await listWatches(db, candidateId))[0]).toMatchObject({
      status: "quarantined",
      lastError: "FetchRefused",
    });
  });

  it("retry puts a quarantined board back to ok and due now", async () => {
    const { id } = await addWatch(db, { candidateId, now: NOW, watch: globex });
    await savePollResult(db, {
      candidateId,
      watchId: id,
      now: NOW,
      result: { outcome: "failed", seen: 0, added: 0, failed: 0, errorName: "TimeoutError" },
      next: { nextPollAt: later(360), status: "quarantined", consecutiveFailures: 5 },
    });
    expect(await retryWatch(db, { candidateId, watchId: id, now: later(30) })).toBe(true);
    const [row] = await listWatches(db, candidateId);
    expect(row).toMatchObject({ status: "ok", consecutiveFailures: 0, nextPollAt: later(30) });
  });

  it("removes a board, and says so when there is none", async () => {
    const { id } = await addWatch(db, { candidateId, now: NOW, watch: globex });
    expect(await removeWatch(db, { candidateId, watchId: id, now: NOW })).toBe(true);
    expect(await removeWatch(db, { candidateId, watchId: id, now: NOW })).toBe(false);
    expect(await listWatches(db, candidateId)).toEqual([]);
  });

  it("retrying and removing a board are in the feed, stamped with the caller's clock", async () => {
    const { id } = await addWatch(db, { candidateId, now: NOW, watch: globex });
    await retryWatch(db, { candidateId, watchId: id, now: later(1) });
    await removeWatch(db, { candidateId, watchId: id, now: later(2) });
    expect((await events()).map((e) => [e.type, e.actor, e.occurredAt])).toEqual([
      ["source.watched", "user", NOW],
      ["source.retried", "user", later(1)],
      ["source.unwatched", "user", later(2)],
    ]);
  });

  it("the database refuses a tier outside 1 to 3", async () => {
    const bad = db.insert(companyWatch).values({ ...globex, tier: 4, candidateId });
    expect(await sqlState(bad)).toBe(CHECK_VIOLATION);
  });
});
