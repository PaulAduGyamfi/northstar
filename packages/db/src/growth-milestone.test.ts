import { createHash } from "node:crypto";
import { CandidateId } from "@northstar/domain";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { growthMilestone, growthTrack, growthTrackSet } from "./growth-schema.js";
import { type GrowthTrackInput, readGrowthTracks, setGrowthTracks } from "./growth-write.js";
import { candidate, domainEvent } from "./schema.js";
import { createTestDb, sqlState } from "./test/pglite.js";

// Growth goals, definitions of done and milestones (NS-232, GRW-001/002) on PGlite. Invented
// tracks only.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";

const exporter = new InMemorySpanExporter();
beforeAll(() => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});
afterAll(() => {
  trace.disable();
});

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  candidateId = CandidateId.parse(c.id);
  exporter.reset();
});
afterEach(() => close());

const PLAIN: GrowthTrackInput = {
  key: "side-app",
  name: "Budget app",
  type: "project",
  status: "paused",
  priority: 2,
  target: null,
  untouchedDays: 14,
  next: null,
};
const DETAILED: GrowthTrackInput = {
  key: "cloud-cert",
  name: "Cloud certification",
  type: "cert",
  status: "active",
  priority: 4,
  target: null,
  untouchedDays: 7,
  next: null,
  goal: "Pass the associate exam",
  doneWhen: "Certificate issued",
  milestones: [
    { title: "Sections 1-12", doneOn: "2026-11-20" },
    { title: "Practice exams at 80%", doneOn: null },
    { title: "Exam booked", doneOn: null },
  ],
};

describe("growth goals and milestones", () => {
  it("stores a track's goal, definition of done and milestones with the version and reads them back in order", async () => {
    await setGrowthTracks(db, { candidateId, tracks: [DETAILED, PLAIN] });
    const read = await readGrowthTracks(db, candidateId);
    expect(read?.tracks).toEqual([
      { ...DETAILED, lastTouchedAt: null },
      { ...PLAIN, lastTouchedAt: null },
    ]);
  });

  it("leaves the fields off a track that has none, as before", async () => {
    await setGrowthTracks(db, { candidateId, tracks: [PLAIN] });
    const [track] = (await readGrowthTracks(db, candidateId))?.tracks ?? [];
    expect(track && ["goal" in track, "doneWhen" in track, "milestones" in track]).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("hashes a file without goals or milestones exactly as before NS-232, so it isn't stored again", async () => {
    await setGrowthTracks(db, { candidateId, tracks: [PLAIN] });
    const [set] = await db.select({ sha: growthTrackSet.contentSha256 }).from(growthTrackSet);
    // The NS-210 formula: the nine track fields, in order.
    const before = createHash("sha256")
      .update(
        JSON.stringify([["side-app", "Budget app", "project", "paused", 2, null, 14, null, null]]),
      )
      .digest("hex");
    expect(set?.sha).toBe(before);
  });

  it("stores a new version when only a milestone changes, and nothing for the same file", async () => {
    await setGrowthTracks(db, { candidateId, tracks: [DETAILED] });
    const same = await setGrowthTracks(db, { candidateId, tracks: [DETAILED] });
    const done = await setGrowthTracks(db, {
      candidateId,
      tracks: [
        {
          ...DETAILED,
          milestones: [
            { title: "Sections 1-12", doneOn: "2026-11-20" },
            { title: "Exam booked", doneOn: "2026-12-01" },
          ],
        },
      ],
    });
    const read = await readGrowthTracks(db, candidateId);
    expect([same.status, done.version, read?.tracks[0]?.milestones]).toEqual([
      "unchanged",
      2,
      [
        { title: "Sections 1-12", doneOn: "2026-11-20" },
        { title: "Exam booked", doneOn: "2026-12-01" },
      ],
    ]);
  });

  it("puts no goal, definition of done or milestone in any event or span", async () => {
    await setGrowthTracks(db, { candidateId, tracks: [DETAILED] });
    await readGrowthTracks(db, candidateId);
    const events = await db.select().from(domainEvent);
    const text = JSON.stringify(
      [events, exporter.getFinishedSpans().map((s) => [s.name, s.attributes, s.events])],
      (_k, v) => (typeof v === "bigint" ? String(v) : v),
    );
    expect([
      exporter.getFinishedSpans().length > 0,
      /associate exam|Certificate issued|Sections 1-12|Practice exams|Exam booked/.test(text),
    ]).toEqual([true, false]);
  });

  it("keeps milestones append-only", async () => {
    await setGrowthTracks(db, { candidateId, tracks: [DETAILED] });
    expect([
      await sqlState(db.update(growthMilestone).set({ title: "Changed" })),
      await sqlState(db.delete(growthMilestone)),
      await sqlState(db.execute(sql`truncate growth_milestone`)),
    ]).toEqual([RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION]);
  });

  it("refuses a goal or milestone with a control character, or an empty one, in the database too", async () => {
    await setGrowthTracks(db, { candidateId, tracks: [DETAILED] });
    const [set] = await db.select({ id: growthTrackSet.id }).from(growthTrackSet);
    const [track] = await db.select({ id: growthTrack.id }).from(growthTrack);
    const row = { ...PLAIN, candidateId, setId: set?.id ?? "", position: 1 };
    expect([
      await sqlState(
        db.insert(growthTrack).values({ ...row, key: "a", goal: "Line\nbreak", targetDate: null }),
      ),
      await sqlState(
        db.insert(growthTrack).values({ ...row, key: "b", doneWhen: "   ", targetDate: null }),
      ),
      await sqlState(
        db
          .insert(growthMilestone)
          .values({ candidateId, trackId: track?.id ?? "", position: 7, title: "Tab\there" }),
      ),
      await sqlState(
        db
          .insert(growthMilestone)
          .values({ candidateId, trackId: track?.id ?? "", position: 20, title: "Too far" }),
      ),
    ]).toEqual([CHECK_VIOLATION, CHECK_VIOLATION, CHECK_VIOLATION, CHECK_VIOLATION]);
  });
});
