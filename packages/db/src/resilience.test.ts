import {
  BASE_COOLDOWN_MS,
  CandidateId,
  FAILURE_THRESHOLD,
  PROBE_TIMEOUT_MS,
} from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireCall, readBreakers, recordCallOutcome } from "./breaker-write.js";
import type { Db } from "./db.js";
import { isSubsystemOn, readKillSwitches, setKillSwitch } from "./kill-switch-write.js";
import { readEventsAfter } from "./read-events.js";
import { killSwitch } from "./resilience-schema.js";
import { candidate, domainEvent } from "./schema.js";
import { createTestDb, sqlState } from "./test/pglite.js";

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";
const T0 = new Date("2026-11-25T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

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

const eventsOf = (prefix: string) =>
  db
    .select()
    .from(domainEvent)
    .where(sql`${domainEvent.type} like ${`${prefix}%`}`)
    .orderBy(domainEvent.position);

async function fail(dependency: string, times: number, now = T0, error = "TimeoutError") {
  for (let i = 0; i < times; i++) {
    await recordCallOutcome(db, {
      candidateId,
      dependency,
      outcome: { ok: false, error },
      now,
    });
  }
}

describe("stored circuit breakers", () => {
  it("open after five failures and refuse calls until retryAt", async () => {
    await fail("gmail", FAILURE_THRESHOLD);
    expect(await acquireCall(db, { candidateId, dependency: "gmail", now: at(1000) })).toEqual({
      allowed: false,
      retryAt: at(BASE_COOLDOWN_MS),
      lastError: "TimeoutError",
    });
    // Another dependency is untouched.
    expect(await acquireCall(db, { candidateId, dependency: "anthropic", now: at(1000) })).toEqual({
      allowed: true,
      probe: false,
    });
  });

  it("allow one probe after the pause, and close on its success", async () => {
    await fail("gmail", FAILURE_THRESHOLD);
    const after = at(BASE_COOLDOWN_MS);
    const probeToken = at(BASE_COOLDOWN_MS + PROBE_TIMEOUT_MS).toISOString();
    expect(await acquireCall(db, { candidateId, dependency: "gmail", now: after })).toEqual({
      allowed: true,
      probe: true,
      probeToken,
    });
    expect((await acquireCall(db, { candidateId, dependency: "gmail", now: after })).allowed).toBe(
      false,
    );
    // A late success from a call that started before the pause doesn't settle the probe.
    const late = await recordCallOutcome(db, {
      candidateId,
      dependency: "gmail",
      outcome: { ok: true },
      now: after,
    });
    expect(late.status).toBe("half_open");
    const state = await recordCallOutcome(db, {
      candidateId,
      dependency: "gmail",
      outcome: { ok: true },
      probeToken,
      now: after,
    });
    expect(state.status).toBe("closed");
    expect((await eventsOf("breaker.")).map((e) => e.type)).toEqual([
      "breaker.opened",
      "breaker.probing",
      "breaker.closed",
    ]);
  });

  it("let another caller probe once a probe never reports", async () => {
    await fail("gmail", FAILURE_THRESHOLD);
    await acquireCall(db, { candidateId, dependency: "gmail", now: at(BASE_COOLDOWN_MS) });
    const late = at(BASE_COOLDOWN_MS + PROBE_TIMEOUT_MS);
    expect(await acquireCall(db, { candidateId, dependency: "gmail", now: late })).toEqual({
      allowed: true,
      probe: true,
      probeToken: at(BASE_COOLDOWN_MS + 2 * PROBE_TIMEOUT_MS).toISOString(),
    });
  });

  it("write events only on changes of state, with no error message", async () => {
    await fail("ats:greenhouse", FAILURE_THRESHOLD + 3);
    await recordCallOutcome(db, {
      candidateId,
      dependency: "anthropic",
      outcome: { ok: false, error: "Rate limited by https://api.example.com/v1?key=abc" },
      now: T0,
    });
    const events = await eventsOf("breaker.");
    expect(events.map((e) => e.payload)).toEqual([
      {
        dependency: "ats:greenhouse",
        from: "closed",
        to: "open",
        consecutiveFailures: 5,
        opens: 1,
        retryAt: at(BASE_COOLDOWN_MS).toISOString(),
        lastError: "TimeoutError",
      },
    ]);
    const [anthropic] = (await readBreakers(db, candidateId)).filter(
      (b) => b.dependency === "anthropic",
    );
    expect(anthropic?.lastError).toBe("Error");
  });

  it("refuse a dependency name that isn't a plain name", async () => {
    await expect(
      acquireCall(db, { candidateId, dependency: "https://evil.example", now: T0 }),
    ).rejects.toThrow("invalid dependency name");
  });
});

describe("the feed", () => {
  it("reads breaker and kill switch events back through readEventsAfter", async () => {
    await fail("gmail", FAILURE_THRESHOLD);
    await setKillSwitch(db, {
      candidateId,
      subsystem: "adapter:lever",
      enabled: false,
      actor: "user",
      reason: "Layout changed",
    });
    const events = await readEventsAfter(db, candidateId, 0n, 10);
    expect(events.map((e) => e.event.type)).toEqual(["breaker.opened", "kill_switch.set"]);
  });
});

describe("kill switches", () => {
  const off = (subsystem: string, reason = "Adapter broke after a layout change") =>
    setKillSwitch(db, { candidateId, subsystem, enabled: false, actor: "user", reason });
  const on = (subsystem: string) =>
    setKillSwitch(db, { candidateId, subsystem, enabled: true, actor: "user", reason: "Fixed" });

  it("a subsystem never switched is on", async () => {
    expect(await isSubsystemOn(db, candidateId, "auto_apply")).toBe(true);
  });

  it("turning a subsystem off takes effect at once, and on again restores it", async () => {
    expect(await off("adapter:lever")).toEqual({ ok: true, changed: true });
    expect(await isSubsystemOn(db, candidateId, "adapter:lever")).toBe(false);
    expect(await isSubsystemOn(db, candidateId, "adapter:greenhouse")).toBe(true);
    expect(await on("adapter:lever")).toEqual({ ok: true, changed: true });
    expect(await isSubsystemOn(db, candidateId, "adapter:lever")).toBe(true);
    const events = await eventsOf("kill_switch.");
    expect(events.map((e) => e.payload)).toEqual([
      { subsystem: "adapter:lever", enabled: false, reason: "Adapter broke after a layout change" },
      { subsystem: "adapter:lever", enabled: true, reason: "Fixed" },
    ]);
  });

  it("setting the state a subsystem is already in stores nothing", async () => {
    await off("auto_apply");
    expect(await off("auto_apply")).toEqual({ ok: true, changed: false });
    expect(await on("outreach_send")).toEqual({ ok: true, changed: false });
    expect((await db.select().from(killSwitch)).length).toBe(1);
    expect((await eventsOf("kill_switch.")).length).toBe(1);
  });

  it("refuses an unknown subsystem and an empty reason", async () => {
    expect(await off("everything")).toEqual({ ok: false, error: { kind: "InvalidSubsystem" } });
    expect(await off("auto_apply", "   ")).toEqual({
      ok: false,
      error: { kind: "ReasonRequired" },
    });
    expect(
      await sqlState(
        db.insert(killSwitch).values({
          candidateId,
          subsystem: "source:Lever Jobs",
          enabled: false,
          actor: "user",
          reason: "x",
        }),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it("lists each subsystem's current state", async () => {
    await off("adapter:lever");
    await on("adapter:lever");
    await off("auto_apply", "Pausing for the weekend");
    const view = await readKillSwitches(db, candidateId);
    expect(view.map((v) => [v.subsystem, v.enabled, v.reason])).toEqual([
      ["adapter:lever", true, "Fixed"],
      ["auto_apply", false, "Pausing for the weekend"],
    ]);
  });

  it("refuses to update or delete a kill switch row", async () => {
    await off("auto_apply");
    expect(await sqlState(db.update(killSwitch).set({ enabled: true }))).toBe(RESTRICT_VIOLATION);
    expect(
      await sqlState(db.delete(killSwitch).where(eq(killSwitch.subsystem, "auto_apply"))),
    ).toBe(RESTRICT_VIOLATION);
  });
});
