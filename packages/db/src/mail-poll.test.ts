import { CandidateId } from "@northstar/domain";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { mailPollCursor } from "./mail-poll-schema.js";
import { FutureCursorError, readMailCursor, saveMailCursor } from "./mail-poll-write.js";
import { createTestDb, seedApplication, sqlState } from "./test/pglite.js";

// The mail poll's stored cursor (NS-247 slice 2).

const RESTRICT_VIOLATION = "23001";
const T1 = new Date("2026-11-27T10:00:00Z");
const T2 = new Date("2026-11-27T11:00:00Z");

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  candidateId = CandidateId.parse((await seedApplication(db, "submitted")).candidateId);
});

afterEach(async () => {
  await close();
});

// A fixed clock after both test times, so the future-cursor check never depends on the real date.
const NOW = () => new Date("2026-11-28T00:00:00Z");
const save = (since: Date, overlap = true) =>
  saveMailCursor(db, { candidateId, since, overlap }, NOW);

describe("readMailCursor and saveMailCursor", () => {
  it("reads nothing before the first save", async () => {
    expect(await readMailCursor(db, candidateId)).toBeNull();
  });

  it("stores a cursor and reads the newest one back", async () => {
    await save(T1);
    expect(await save(T2, false)).toEqual({ saved: true, cursor: { since: T2, overlap: false } });
    expect(await readMailCursor(db, candidateId)).toEqual({ since: T2, overlap: false });
  });

  it("stores nothing when the cursor didn't move", async () => {
    await save(T1);
    expect(await save(T1)).toEqual({ saved: false, cursor: { since: T1, overlap: true } });
    expect(await db.select().from(mailPollCursor)).toHaveLength(1);
  });

  it("never moves the cursor backwards", async () => {
    await save(T2);
    expect(await save(T1, false)).toEqual({ saved: false, cursor: { since: T2, overlap: true } });
    expect(await readMailCursor(db, candidateId)).toEqual({ since: T2, overlap: true });
  });

  it("stores a change of overlap alone", async () => {
    await save(T1, true);
    expect((await save(T1, false)).saved).toBe(true);
    expect(await readMailCursor(db, candidateId)).toEqual({ since: T1, overlap: false });
  });

  it("refuses a cursor after now, beyond the clock skew, and stores nothing", async () => {
    const now = () => T1;
    await expect(
      saveMailCursor(
        db,
        { candidateId, since: new Date(T1.getTime() + 6 * 60_000), overlap: true },
        now,
      ),
    ).rejects.toBeInstanceOf(FutureCursorError);
    expect(await readMailCursor(db, candidateId)).toBeNull();
    // Within the skew it is stored.
    const within = await saveMailCursor(
      db,
      { candidateId, since: new Date(T1.getTime() + 60_000), overlap: true },
      now,
    );
    expect(within.saved).toBe(true);
  });

  it("keeps each candidate's cursor apart", async () => {
    const other = CandidateId.parse((await seedApplication(db, "submitted")).candidateId);
    await save(T2);
    expect(await readMailCursor(db, other)).toBeNull();
  });
});

describe("the mail_poll_cursor table", () => {
  it("refuses UPDATE, DELETE and TRUNCATE", async () => {
    await save(T1);
    expect([
      await sqlState(db.execute(sql`UPDATE mail_poll_cursor SET overlap = false`)),
      await sqlState(db.execute(sql`DELETE FROM mail_poll_cursor`)),
      await sqlState(db.execute(sql`TRUNCATE mail_poll_cursor`)),
    ]).toEqual([RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION]);
  });
});
