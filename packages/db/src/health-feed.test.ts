import { CandidateId, FAILURE_THRESHOLD } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireCall, recordCallOutcome } from "./breaker-write.js";
import type { Db } from "./db.js";
import { readFeed, readFeedAfter } from "./feed-read.js";
import { readSystemHealth } from "./health-read.js";
import { setKillSwitch } from "./kill-switch-write.js";
import { candidate } from "./schema.js";
import { createTestDb } from "./test/pglite.js";
import { addWatch, savePollResult } from "./watch-write.js";

const T0 = new Date("2026-11-25T12:00:00Z");

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

// Opens a dependency's breaker the way callers do: FAILURE_THRESHOLD failed calls in a row.
async function openBreaker(dependency: string): Promise<void> {
  for (let i = 0; i < FAILURE_THRESHOLD; i++) {
    await acquireCall(db, { candidateId, dependency, now: T0 });
    await recordCallOutcome(db, {
      candidateId,
      dependency,
      outcome: { ok: false, error: "RateLimited" },
      now: T0,
    });
  }
}

async function quarantinedBoard(): Promise<string> {
  const { id } = await addWatch(db, {
    candidateId,
    now: T0,
    watch: { ats: "greenhouse", board: "acme", url: "https://boards.greenhouse.io/acme", tier: 1 },
  });
  await savePollResult(db, {
    candidateId,
    watchId: id,
    now: T0,
    result: { outcome: "failed", seen: 0, added: 0, failed: 0, errorName: "TimeoutError" },
    next: { nextPollAt: T0, status: "quarantined", consecutiveFailures: 5 },
  });
  return id;
}

describe("readSystemHealth", () => {
  it("is healthy with no stored state", async () => {
    expect(await readSystemHealth(db, candidateId)).toEqual({ overall: "healthy", subsystems: [] });
  });

  it("reports an open breaker, a switched-off subsystem and a quarantined board, worst first", async () => {
    await openBreaker("anthropic");
    await acquireCall(db, { candidateId, dependency: "gmail", now: T0 });
    await recordCallOutcome(db, {
      candidateId,
      dependency: "gmail",
      outcome: { ok: true },
      now: T0,
    });
    await setKillSwitch(db, {
      candidateId,
      subsystem: "auto_apply",
      enabled: false,
      actor: "user",
      reason: "On holiday",
    });
    const watchId = await quarantinedBoard();

    const health = await readSystemHealth(db, candidateId);
    expect(health.overall).toBe("degraded");
    expect(health.subsystems.map((s) => [s.subsystem, s.health, s.reason])).toEqual([
      ["anthropic", "down", "Paused after repeated failures (RateLimited)"],
      ["auto_apply", "down", "Switched off by you: On holiday"],
      [
        `board:greenhouse:${watchId}`,
        "degraded",
        "Quarantined after 5 failed reads; put it back with jobs watch retry",
      ],
      ["gmail", "healthy", "Working"],
    ]);
  });
});

describe("readFeed", () => {
  it("returns plain sentences, newest first", async () => {
    await openBreaker("anthropic");
    await setKillSwitch(db, {
      candidateId,
      subsystem: "auto_apply",
      enabled: false,
      actor: "user",
      reason: "On holiday",
    });
    const feed = await readFeed(db, candidateId, { limit: 10 });
    expect(feed.map((f) => [f.type, f.actor, f.line])).toEqual([
      ["kill_switch.set", "user", "You switched off auto_apply"],
      ["breaker.opened", "system", "Paused anthropic after 5 failed calls (RateLimited)"],
    ]);
  });

  it("pages backwards with the last position shown", async () => {
    await quarantinedBoard();
    for (const subsystem of ["auto_apply", "outreach_send"]) {
      await setKillSwitch(db, {
        candidateId,
        subsystem,
        enabled: false,
        actor: "user",
        reason: "x",
      });
    }
    const first = await readFeed(db, candidateId, { limit: 2 });
    const last = first.at(-1);
    if (!last) throw new Error("empty first page");
    const second = await readFeed(db, candidateId, { before: last.position, limit: 10 });
    expect([first, second].map((page) => page.map((f) => f.line))).toEqual([
      ["You switched off outreach_send", "You switched off auto_apply"],
      [
        "Quarantined a Greenhouse board after 5 failed reads",
        "Couldn't read a Greenhouse board",
        "You started watching a Greenhouse board (tier 1)",
      ],
    ]);
  });

  it("shows only the candidate's own events", async () => {
    const [other] = await db.insert(candidate).values({ displayName: "Other" }).returning();
    if (!other) throw new Error("no candidate");
    await setKillSwitch(db, {
      candidateId: CandidateId.parse(other.id),
      subsystem: "auto_apply",
      enabled: false,
      actor: "user",
      reason: "x",
    });
    expect(await readFeed(db, candidateId, { limit: 10 })).toEqual([]);
  });

  it("refuses a page size outside 1 to 200", async () => {
    for (const limit of [0, 201, 1.5]) {
      await expect(readFeed(db, candidateId, { limit })).rejects.toThrow(
        "feed page size must be 1 to 200",
      );
    }
  });
});

describe("readFeedAfter", () => {
  const off = (subsystem: string) =>
    setKillSwitch(db, { candidateId, subsystem, enabled: false, actor: "user", reason: "x" });

  it("returns only the lines after the position, oldest first", async () => {
    await off("auto_apply");
    const [newest] = await readFeed(db, candidateId, { limit: 1 });
    if (!newest) throw new Error("no event");
    await off("outreach_send");
    await off("inbox_auto_label");
    const after = await readFeedAfter(db, candidateId, { after: newest.position, limit: 10 });
    expect(after.map((f) => f.line)).toEqual([
      "You switched off outreach_send",
      "You switched off inbox_auto_label",
    ]);
  });

  it("returns nothing when nothing is newer", async () => {
    await off("auto_apply");
    const [newest] = await readFeed(db, candidateId, { limit: 1 });
    if (!newest) throw new Error("no event");
    expect(await readFeedAfter(db, candidateId, { after: newest.position, limit: 10 })).toEqual([]);
  });

  it("shows only the candidate's own events", async () => {
    const [other] = await db.insert(candidate).values({ displayName: "Other" }).returning();
    if (!other) throw new Error("no candidate");
    await setKillSwitch(db, {
      candidateId: CandidateId.parse(other.id),
      subsystem: "auto_apply",
      enabled: false,
      actor: "user",
      reason: "x",
    });
    expect(await readFeedAfter(db, candidateId, { after: 0n, limit: 10 })).toEqual([]);
  });

  it("refuses a page size outside 1 to 200", async () => {
    await expect(readFeedAfter(db, candidateId, { after: 0n, limit: 0 })).rejects.toThrow(
      "feed page size must be 1 to 200",
    );
  });
});
