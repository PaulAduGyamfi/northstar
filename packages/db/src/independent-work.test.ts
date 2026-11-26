import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import {
  independentWorkEntry,
  independentWorkLine,
  independentWorkSet,
} from "./independent-work-schema.js";
import {
  type IndependentWorkInput,
  readIndependentWork,
  setIndependentWork,
} from "./independent-work-write.js";
import { candidate, domainEvent } from "./schema.js";
import { createTestDb, sqlState } from "./test/pglite.js";

// Paul's independent-work entries (NS-196) on PGlite. Invented projects only.

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

const WORK: IndependentWorkInput[] = [
  {
    title: "Ledgerline",
    start: "2026-02",
    end: null,
    link: "https://example.com/ledgerline",
    lines: ["Built a budgeting app used by 40 testers", "Shipped weekly releases"],
  },
  {
    title: "Cloud certification",
    start: "2026-01",
    end: "2026-04",
    link: null,
    lines: ["Passed the associate exam"],
  },
];

const set = (entries: IndependentWorkInput[] = WORK) =>
  setIndependentWork(db, { candidateId, entries });

describe("setIndependentWork", () => {
  it("stores the list as version 1 and reads it back in file order", async () => {
    const result = await set();
    const read = await readIndependentWork(db, candidateId);
    expect([result, read?.version, read?.entries]).toEqual([
      { status: "set", version: 1, entries: 2, lines: 3 },
      1,
      WORK,
    ]);
  });

  it("stores nothing for the same list again", async () => {
    await set();
    const again = await set();
    const sets = await db.select().from(independentWorkSet);
    expect([again.status, again.version, sets.length]).toEqual(["unchanged", 1, 1]);
  });

  it("stores a changed list as the next version and keeps the old one", async () => {
    await set();
    const changed = await set([
      { ...WORK[0], lines: ["Built a budgeting app"] } as IndependentWorkInput,
    ]);
    const read = await readIndependentWork(db, candidateId);
    const entries = await db.select().from(independentWorkEntry);
    expect([changed.version, read?.entries.map((e) => e.lines), entries.length]).toEqual([
      2,
      [["Built a budgeting app"]],
      3,
    ]);
  });

  it("writes an event with the version and counts, never a title, line or link", async () => {
    await set();
    const [event] = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.type, "independent_work.set"));
    expect([
      event?.actor,
      event?.payload.version,
      event?.payload.entries,
      event?.payload.lines,
    ]).toEqual(["user", 1, 2, 3]);
    expect(JSON.stringify(event, (_k, v) => (typeof v === "bigint" ? String(v) : v))).not.toMatch(
      /Ledgerline|budgeting|example\.com/,
    );
  });

  it("reads nothing before the first version", async () => {
    expect(await readIndependentWork(db, candidateId)).toBeNull();
  });

  it("stores nothing when a field breaks the database's rules, in an error without Paul's words", async () => {
    const bad = [{ ...WORK[1], end: "2025-12" } as IndependentWorkInput];
    const error = await set(bad).catch((e: Error) => e.message);
    const sets = await db.select().from(independentWorkSet);
    expect([error, sets.length]).toEqual(["independent_work.set failed", 0]);
  });
});

describe("independent-work tables", () => {
  it("refuse changing or deleting a stored line", async () => {
    await set();
    expect([
      await sqlState(db.update(independentWorkLine).set({ text: "changed" })),
      await sqlState(db.delete(independentWorkLine)),
      await sqlState(db.execute(sql`truncate independent_work_set cascade`)),
    ]).toEqual([RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION]);
  });

  it("refuse a line with a line break in it", async () => {
    await set();
    const [entry] = await db.select().from(independentWorkEntry).limit(1);
    const attempt = db.insert(independentWorkLine).values({
      candidateId,
      entryId: entry?.id ?? "",
      position: 5,
      text: "two\nlines",
    });
    expect(await sqlState(attempt)).toBe(CHECK_VIOLATION);
  });
});
