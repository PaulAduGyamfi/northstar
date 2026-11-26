import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { growthCheckIn, growthPlan, growthReview, growthTrackSet } from "./growth-schema.js";
import {
  type GrowthTrackInput,
  readCheckIns,
  readGrowthSettings,
  readGrowthTracks,
  readWeekPlan,
  readWeekReview,
  recordCheckIn,
  recordGrowthTouch,
  saveWeekPlan,
  saveWeekReview,
  setGrowthSettings,
  setGrowthTracks,
} from "./growth-write.js";
import { candidate, domainEvent } from "./schema.js";
import { createTestDb, sqlState } from "./test/pglite.js";

// The growth tracker's storage (NS-210) on PGlite. Invented tracks only.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";

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

const TRACKS: GrowthTrackInput[] = [
  {
    key: "cloud-cert",
    name: "Cloud certification",
    type: "cert",
    status: "active",
    priority: 4,
    target: "2027-02-01",
    untouchedDays: 7,
    next: { title: "Practice exam 1", minutes: 60 },
  },
  {
    key: "side-app",
    name: "Budget app",
    type: "project",
    status: "paused",
    priority: 2,
    target: null,
    untouchedDays: 14,
    next: null,
  },
];

const PLAN = { focus: [{ trackId: "cloud-cert", blocks: [60, 60] }], maintenance: [] };

describe("growth tracks", () => {
  it("stores the file as version 1 and reads it back with no touches", async () => {
    const result = await setGrowthTracks(db, { candidateId, tracks: TRACKS });
    const read = await readGrowthTracks(db, candidateId);
    expect([result, read?.version, read?.tracks]).toEqual([
      { status: "set", version: 1, tracks: 2 },
      1,
      TRACKS.map((t) => ({ ...t, lastTouchedAt: null })),
    ]);
  });

  it("stores nothing for the same tracks, and the next version for changed ones", async () => {
    await setGrowthTracks(db, { candidateId, tracks: TRACKS });
    const same = await setGrowthTracks(db, { candidateId, tracks: TRACKS });
    const changed = await setGrowthTracks(db, {
      candidateId,
      tracks: [{ ...(TRACKS[0] as GrowthTrackInput), status: "done" }],
    });
    const sets = await db.select().from(growthTrackSet);
    expect([same.status, changed.version, sets.length]).toEqual(["unchanged", 2, 2]);
  });

  it("writes events with versions and counts, never a key, name or next action", async () => {
    await setGrowthTracks(db, { candidateId, tracks: TRACKS });
    await recordGrowthTouch(db, { candidateId, key: "cloud-cert" });
    await saveWeekPlan(db, {
      candidateId,
      weekStart: "2026-11-23",
      trackSetVersion: 1,
      plan: PLAN,
      counts: { focus: 1, maintenance: 0, atRisk: 0 },
    });
    const events = await db.select().from(domainEvent);
    const text = JSON.stringify(events, (_k, v) => (typeof v === "bigint" ? String(v) : v));
    expect([
      events.map((e) => e.type),
      /cloud-cert|Cloud certification|Practice exam|side-app|Budget app/.test(text),
    ]).toEqual([["growth.tracks_set", "growth.touched", "growth.planned"], false]);
  });
});

describe("growth touches", () => {
  it("moves a track's last touch to its newest touch", async () => {
    await setGrowthTracks(db, { candidateId, tracks: TRACKS });
    await recordGrowthTouch(db, {
      candidateId,
      key: "cloud-cert",
      at: new Date("2026-11-20T10:00:00Z"),
    });
    await recordGrowthTouch(db, {
      candidateId,
      key: "cloud-cert",
      at: new Date("2026-11-24T10:00:00Z"),
    });
    const read = await readGrowthTracks(db, candidateId);
    expect(read?.tracks.map((t) => t.lastTouchedAt?.toISOString() ?? null)).toEqual([
      "2026-11-24T10:00:00.000Z",
      null,
    ]);
  });

  it("refuses a key that isn't a current track, storing nothing", async () => {
    await setGrowthTracks(db, { candidateId, tracks: TRACKS });
    expect(await recordGrowthTouch(db, { candidateId, key: "nope" })).toEqual({
      ok: false,
      error: { kind: "UnknownTrack" },
    });
    expect((await db.select().from(domainEvent)).length).toBe(1);
  });
});

describe("growth settings", () => {
  it("reads null before any, then the newest", async () => {
    const before = await readGrowthSettings(db, candidateId);
    const s = {
      weeklyMinutes: 600,
      wipLimit: 3,
      blockMinutes: 60,
      maintenanceMinutes: 30,
      minFocusSessions: 2,
    };
    await setGrowthSettings(db, { candidateId, settings: s });
    await setGrowthSettings(db, { candidateId, settings: { ...s, weeklyMinutes: 300 } });
    expect([before, (await readGrowthSettings(db, candidateId))?.weeklyMinutes]).toEqual([
      null,
      300,
    ]);
  });

  it("refuses settings outside the planner's ranges", async () => {
    const bad = {
      weeklyMinutes: 600,
      wipLimit: 0,
      blockMinutes: 60,
      maintenanceMinutes: 30,
      minFocusSessions: 2,
    };
    const error = await setGrowthSettings(db, { candidateId, settings: bad }).catch(
      (e: Error) => e.message,
    );
    expect(error).toBe("growth.settings_set failed");
  });
});

describe("weekly plans", () => {
  it("stores a week's plan once and returns the first when planned again", async () => {
    const counts = { focus: 1, maintenance: 0, atRisk: 0 };
    const first = await saveWeekPlan(db, {
      candidateId,
      weekStart: "2026-11-23",
      trackSetVersion: 1,
      plan: PLAN,
      counts,
    });
    const again = await saveWeekPlan(db, {
      candidateId,
      weekStart: "2026-11-23",
      trackSetVersion: 2,
      plan: { focus: [], maintenance: [] },
      counts,
    });
    const rows = await db.select().from(growthPlan);
    const planned = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.type, "growth.planned"));
    expect([first.status, again, rows.length, planned.length]).toEqual([
      "planned",
      { weekStart: "2026-11-23", trackSetVersion: 1, plan: PLAN, status: "existing" },
      1,
      1,
    ]);
  });

  it("refuses a week that doesn't start on a Monday", async () => {
    const attempt = db.insert(growthPlan).values({
      candidateId,
      weekStart: "2026-11-24",
      trackSetVersion: 1,
      plan: PLAN,
    });
    expect(await sqlState(attempt)).toBe(CHECK_VIOLATION);
  });

  it("can't be changed once stored", async () => {
    await saveWeekPlan(db, {
      candidateId,
      weekStart: "2026-11-23",
      trackSetVersion: 1,
      plan: PLAN,
      counts: { focus: 1, maintenance: 0, atRisk: 0 },
    });
    expect([
      await sqlState(db.update(growthPlan).set({ trackSetVersion: 9 })),
      await sqlState(db.execute(sql`truncate growth_plan`)),
    ]).toEqual([RESTRICT_VIOLATION, RESTRICT_VIOLATION]);
  });
});

describe("growth check-ins", () => {
  const checkIn = (over: Partial<Parameters<typeof recordCheckIn>[1]> = {}) =>
    recordCheckIn(db, {
      candidateId,
      key: "cloud-cert",
      minutes: 45,
      percent: 30,
      idempotencyKey: "check-in-0001",
      at: new Date("2026-11-24T09:00:00Z"),
      ...over,
    });

  it("stores a check-in once for a repeated idempotency key", async () => {
    await setGrowthTracks(db, { candidateId, tracks: TRACKS });
    const first = await checkIn();
    const again = await checkIn({ minutes: 90 });
    const rows = await db.select().from(growthCheckIn);
    const events = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.type, "growth.checked_in"));
    expect([first, again, rows.length, rows[0]?.minutes, events.length]).toEqual([
      { ok: true, status: "recorded" },
      { ok: true, status: "replayed" },
      1,
      45,
      1,
    ]);
  });

  it("refuses a key that isn't a current track, storing nothing", async () => {
    await setGrowthTracks(db, { candidateId, tracks: TRACKS });
    expect([
      await checkIn({ key: "nope" }),
      (await db.select().from(growthCheckIn)).length,
    ]).toEqual([{ ok: false, error: { kind: "UnknownTrack" } }, 0]);
  });

  it("moves the track's last touch, so the planner sees it", async () => {
    await setGrowthTracks(db, { candidateId, tracks: TRACKS });
    await recordGrowthTouch(db, {
      candidateId,
      key: "cloud-cert",
      at: new Date("2026-11-20T10:00:00Z"),
    });
    await checkIn();
    const read = await readGrowthTracks(db, candidateId);
    expect(read?.tracks[0]?.lastTouchedAt?.toISOString()).toBe("2026-11-24T09:00:00.000Z");
  });

  it("reads check-ins since a time, oldest first", async () => {
    await setGrowthTracks(db, { candidateId, tracks: TRACKS });
    await checkIn({ idempotencyKey: "check-in-0002", at: new Date("2026-11-25T09:00:00Z") });
    await checkIn({ idempotencyKey: "check-in-0001", at: new Date("2026-11-16T09:00:00Z") });
    await checkIn({
      idempotencyKey: "check-in-0003",
      at: new Date("2026-11-24T09:00:00Z"),
      percent: null,
    });
    const read = await readCheckIns(db, candidateId, new Date("2026-11-23T00:00:00Z"));
    expect(read.map((c) => [c.at.toISOString(), c.percent])).toEqual([
      ["2026-11-24T09:00:00.000Z", null],
      ["2026-11-25T09:00:00.000Z", 30],
    ]);
  });

  it("writes an event with the row id and minutes, never the track key or name", async () => {
    await setGrowthTracks(db, { candidateId, tracks: TRACKS });
    await checkIn();
    const [event] = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.type, "growth.checked_in"));
    const text = JSON.stringify(event, (_k, v) => (typeof v === "bigint" ? String(v) : v));
    expect([
      Object.keys(event?.payload ?? {}).sort(),
      /cloud-cert|Cloud certification/.test(text),
    ]).toEqual([["checkInId", "minutes"], false]);
  });

  it("can't be changed once stored", async () => {
    await setGrowthTracks(db, { candidateId, tracks: TRACKS });
    await checkIn();
    expect(await sqlState(db.update(growthCheckIn).set({ minutes: 1 }))).toBe(RESTRICT_VIOLATION);
  });
});

describe("weekly reviews", () => {
  const MOVED = [{ key: "cloud-cert", minutes: 45, plannedMinutes: 120 }];

  it("stores a week's review once and returns the first when reviewed again", async () => {
    const first = await saveWeekReview(db, {
      candidateId,
      weekStart: "2026-11-16",
      moved: MOVED,
      notReached: ["side-app"],
    });
    const again = await saveWeekReview(db, {
      candidateId,
      weekStart: "2026-11-16",
      moved: [],
      notReached: [],
    });
    const events = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.type, "growth.reviewed"));
    expect([
      first.status,
      again,
      (await db.select().from(growthReview)).length,
      events.length,
    ]).toEqual([
      "reviewed",
      { weekStart: "2026-11-16", moved: MOVED, notReached: ["side-app"], status: "existing" },
      1,
      1,
    ]);
  });

  it("reads a stored review, and null for a week without one", async () => {
    await saveWeekReview(db, {
      candidateId,
      weekStart: "2026-11-16",
      moved: MOVED,
      notReached: [],
    });
    expect([
      await readWeekReview(db, candidateId, "2026-11-16"),
      await readWeekReview(db, candidateId, "2026-11-09"),
    ]).toEqual([{ weekStart: "2026-11-16", moved: MOVED, notReached: [] }, null]);
  });

  it("refuses a week that doesn't start on a Monday", async () => {
    const attempt = db
      .insert(growthReview)
      .values({ candidateId, weekStart: "2026-11-17", review: {} });
    expect(await sqlState(attempt)).toBe(CHECK_VIOLATION);
  });
});

describe("readWeekPlan", () => {
  it("reads a stored week's plan, and null for another week", async () => {
    await saveWeekPlan(db, {
      candidateId,
      weekStart: "2026-11-23",
      trackSetVersion: 1,
      plan: PLAN,
      counts: { focus: 1, maintenance: 0, atRisk: 0 },
    });
    expect([
      await readWeekPlan(db, candidateId, "2026-11-23"),
      await readWeekPlan(db, candidateId, "2026-11-16"),
    ]).toEqual([{ trackSetVersion: 1, plan: PLAN }, null]);
  });
});
