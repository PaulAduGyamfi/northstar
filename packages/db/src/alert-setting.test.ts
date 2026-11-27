import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alertSetting } from "./alert-setting-schema.js";
import { readAlertSettings, setAlertSettings } from "./alert-setting-write.js";
import type { Db } from "./db.js";
import { domainEvent } from "./schema.js";
import { createTestDb, seedApplication, sqlState } from "./test/pglite.js";

// Paul's fresh-job alert settings (NS-199 slice 2). Synthetic values only.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  candidateId = CandidateId.parse((await seedApplication(db, "discovered")).candidateId);
});

afterEach(async () => {
  await close();
});

const events = () =>
  db
    .select({ type: domainEvent.type, payload: domainEvent.payload, reason: domainEvent.reason })
    .from(domainEvent)
    .where(eq(domainEvent.type, "alerts.settings_changed"));

describe("setAlertSettings and readAlertSettings", () => {
  it("reads nothing before Paul sets any alert setting", async () => {
    expect(await readAlertSettings(db, candidateId)).toBeNull();
  });

  it("stores one change with every other field left at the default", async () => {
    const r = await setAlertSettings(db, {
      candidateId,
      change: { quiet: { start: 1320, end: 420 } },
    });
    expect(r).toEqual({
      ok: true,
      value: {
        saved: true,
        settings: { quiet: { start: 1320, end: 420 }, timeZone: null, tier1InQuietHours: null },
      },
    });
    expect(await readAlertSettings(db, candidateId)).toEqual({
      quiet: { start: 1320, end: 420 },
      timeZone: null,
      tier1InQuietHours: null,
    });
  });

  it("merges a later change into the newest settings", async () => {
    await setAlertSettings(db, { candidateId, change: { quiet: "off" } });
    await setAlertSettings(db, { candidateId, change: { timeZone: "Europe/Berlin" } });
    await setAlertSettings(db, { candidateId, change: { tier1InQuietHours: false } });
    expect(await readAlertSettings(db, candidateId)).toEqual({
      quiet: "off",
      timeZone: "Europe/Berlin",
      tier1InQuietHours: false,
    });
  });

  it("puts a field back to the default when the change sets it to null", async () => {
    await setAlertSettings(db, { candidateId, change: { quiet: "off", timeZone: "Asia/Tokyo" } });
    await setAlertSettings(db, { candidateId, change: { quiet: null } });
    expect(await readAlertSettings(db, candidateId)).toEqual({
      quiet: null,
      timeZone: "Asia/Tokyo",
      tier1InQuietHours: null,
    });
  });

  it("writes one event naming only the changed fields, with a fixed sentence", async () => {
    await setAlertSettings(db, {
      candidateId,
      change: { quiet: "off", timeZone: "Europe/Berlin" },
    });
    const [e] = await events();
    expect(e?.reason).toBe("You changed the fresh-job alert settings");
    expect(e?.payload).toMatchObject({ changed: ["quiet", "timeZone"] });
    // The zone itself never goes into the event.
    expect(JSON.stringify(e?.payload)).not.toContain("Berlin");
  });

  it("stores nothing when the change gives the values already stored, twice over", async () => {
    await setAlertSettings(db, { candidateId, change: { quiet: { start: 60, end: 120 } } });
    const again = await setAlertSettings(db, {
      candidateId,
      change: { quiet: { start: 60, end: 120 } },
    });
    expect(again.ok && again.value.saved).toBe(false);
    expect(await db.select().from(alertSetting)).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });

  it("stores nothing when a first change puts a field to its default", async () => {
    const r = await setAlertSettings(db, { candidateId, change: { timeZone: null } });
    expect(r.ok && r.value.saved).toBe(false);
    expect(await db.select().from(alertSetting)).toHaveLength(0);
  });

  it("refuses bad values by field name and stores nothing", async () => {
    const r = await setAlertSettings(db, {
      candidateId,
      change: { quiet: { start: 600, end: 600 }, timeZone: "not a zone!" },
    });
    expect(r).toEqual({
      ok: false,
      error: { kind: "InvalidAlertSettings", fields: ["quiet", "timeZone"] },
    });
    expect(await db.select().from(alertSetting)).toHaveLength(0);
  });

  it("refuses minutes past the end of the day", async () => {
    const r = await setAlertSettings(db, {
      candidateId,
      change: { quiet: { start: 0, end: 1440 } },
    });
    expect(r.ok).toBe(false);
  });

  // PGlite runs one transaction at a time, so this pins the merge, not the row lock itself; the lock
  // is what keeps it true on a real server (review of NS-199 slice 2).
  it("keeps both of two different changes made at the same time", async () => {
    await Promise.all([
      setAlertSettings(db, { candidateId, change: { timeZone: "Europe/Berlin" } }),
      setAlertSettings(db, { candidateId, change: { quiet: "off" } }),
    ]);
    expect(await readAlertSettings(db, candidateId)).toEqual({
      quiet: "off",
      timeZone: "Europe/Berlin",
      tier1InQuietHours: null,
    });
  });

  it("keeps each candidate's settings apart", async () => {
    const other = CandidateId.parse((await seedApplication(db, "discovered")).candidateId);
    await setAlertSettings(db, { candidateId: other, change: { quiet: "off" } });
    expect(await readAlertSettings(db, candidateId)).toBeNull();
  });
});

describe("the alert_setting table", () => {
  it("refuses an update or delete of a stored setting", async () => {
    await setAlertSettings(db, { candidateId, change: { quiet: "off" } });
    expect(await sqlState(db.execute(sql`UPDATE alert_setting SET time_zone = 'UTC'`))).toBe(
      RESTRICT_VIOLATION,
    );
    expect(await sqlState(db.execute(sql`DELETE FROM alert_setting`))).toBe(RESTRICT_VIOLATION);
  });

  it("refuses quiet hours with only one end, equal ends, minutes past the day or an unknown kind", async () => {
    const insert = (kind: string | null, start: number | null, end: number | null) =>
      sqlState(
        db.execute(
          sql`INSERT INTO alert_setting (candidate_id, quiet_kind, quiet_start, quiet_end)
              VALUES (${candidateId}, ${kind}, ${start}, ${end})`,
        ),
      );
    expect(await insert("range", 60, null)).toBe(CHECK_VIOLATION);
    expect(await insert("range", 60, 60)).toBe(CHECK_VIOLATION);
    expect(await insert("off", 60, 120)).toBe(CHECK_VIOLATION);
    expect(await insert(null, 60, 120)).toBe(CHECK_VIOLATION);
    expect(await insert("range", 0, 1440)).toBe(CHECK_VIOLATION);
    expect(await insert("xyz", null, null)).toBe(CHECK_VIOLATION);
    // The three good shapes go in.
    expect(await insert("range", 1320, 420)).toBeNull();
    expect(await insert("off", null, null)).toBeNull();
    expect(await insert(null, null, null)).toBeNull();
  });

  it("refuses a time zone that isn't shaped like a zone name", async () => {
    expect(
      await sqlState(
        db.execute(
          sql`INSERT INTO alert_setting (candidate_id, time_zone) VALUES (${candidateId}, ${"x; drop"})`,
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });
});
