import { describe, expect, it } from "vitest";
import { CLOSED } from "./breaker.js";
import { type HealthInput, systemHealth } from "./health.js";

const RETRY = new Date("2026-11-25T14:05:00Z");
const NONE: HealthInput = { breakers: [], switches: [], watches: [] };

const breaker = (dependency: string, over: Partial<HealthInput["breakers"][number]> = {}) => ({
  ...CLOSED,
  dependency,
  ...over,
});

describe("systemHealth: breakers", () => {
  it("reports a dependency with an open breaker as down, with the error name and retry time", () => {
    const h = systemHealth({
      ...NONE,
      breakers: [
        breaker("anthropic", {
          status: "open",
          consecutiveFailures: 5,
          retryAt: RETRY,
          lastError: "RateLimited",
        }),
      ],
    });
    expect(h.subsystems).toEqual([
      {
        subsystem: "anthropic",
        kind: "dependency",
        health: "down",
        reason: "Paused after repeated failures (RateLimited)",
        retryAt: RETRY,
      },
    ]);
  });

  it("reports a half-open breaker as degraded", () => {
    const h = systemHealth({
      ...NONE,
      breakers: [breaker("gmail", { status: "half_open", retryAt: RETRY })],
    });
    expect(h.subsystems.map((s) => [s.health, s.reason, s.retryAt])).toEqual([
      ["degraded", "Recovering: one test call allowed", null],
    ]);
  });

  it("reports a closed breaker as healthy", () => {
    const h = systemHealth({ ...NONE, breakers: [breaker("gmail")] });
    expect(h.subsystems.map((s) => [s.subsystem, s.health, s.reason])).toEqual([
      ["gmail", "healthy", "Working"],
    ]);
  });

  it("leaves out an error name that isn't a plain identifier", () => {
    const h = systemHealth({
      ...NONE,
      breakers: [breaker("gmail", { status: "open", retryAt: RETRY, lastError: "boom: see url" })],
    });
    expect(h.subsystems[0]?.reason).toBe("Paused after repeated failures");
  });
});

describe("systemHealth: kill switches", () => {
  it("reports a subsystem Paul switched off as down, with his reason", () => {
    const h = systemHealth({
      ...NONE,
      switches: [{ subsystem: "auto_apply", enabled: false, actor: "user", reason: "On holiday" }],
    });
    expect(h.subsystems).toEqual([
      {
        subsystem: "auto_apply",
        kind: "switch",
        health: "down",
        reason: "Switched off by you: On holiday",
        retryAt: null,
      },
    ]);
  });

  it("names the system as the one who switched it off when it wasn't Paul", () => {
    const h = systemHealth({
      ...NONE,
      switches: [{ subsystem: "source:lever", enabled: false, actor: "system", reason: "" }],
    });
    expect(h.subsystems[0]?.reason).toBe("Switched off by Northstar");
  });

  it("reports a switch that is on as healthy", () => {
    const h = systemHealth({
      ...NONE,
      switches: [{ subsystem: "auto_apply", enabled: true, actor: "user", reason: "back" }],
    });
    expect(h.subsystems.map((s) => [s.health, s.reason])).toEqual([["healthy", "Switched on"]]);
  });
});

describe("systemHealth: board watches", () => {
  const watch = (status: "ok" | "backing_off" | "quarantined", consecutiveFailures: number) => ({
    id: "8f14e45f-ceea-4e7a-9d3b-1c2a3b4c5d6e",
    ats: "greenhouse",
    status,
    consecutiveFailures,
  });

  it("reports a quarantined board as degraded, named by ATS and watch id only", () => {
    const h = systemHealth({ ...NONE, watches: [watch("quarantined", 5)] });
    expect(h.subsystems).toEqual([
      {
        subsystem: "board:greenhouse:8f14e45f-ceea-4e7a-9d3b-1c2a3b4c5d6e",
        kind: "board",
        health: "degraded",
        reason: "Quarantined after 5 failed reads; put it back with jobs watch retry",
        retryAt: null,
      },
    ]);
  });

  it("reports a board that is backing off as degraded", () => {
    const h = systemHealth({ ...NONE, watches: [watch("backing_off", 2)] });
    expect(h.subsystems.map((s) => [s.health, s.reason])).toEqual([
      ["degraded", "Backing off after 2 failed reads"],
    ]);
  });

  it("reports a board that reads fine as healthy", () => {
    const h = systemHealth({ ...NONE, watches: [watch("ok", 0)] });
    expect(h.subsystems.map((s) => s.health)).toEqual(["healthy"]);
  });
});

describe("systemHealth: overall", () => {
  it("is healthy when nothing has state yet", () => {
    expect(systemHealth(NONE)).toEqual({ overall: "healthy", subsystems: [] });
  });

  it("is healthy only when every subsystem is, and degraded otherwise, even if one is down", () => {
    expect(systemHealth({ ...NONE, breakers: [breaker("gmail")] }).overall).toBe("healthy");
    const h = systemHealth({
      ...NONE,
      breakers: [breaker("gmail"), breaker("anthropic", { status: "open", retryAt: RETRY })],
    });
    expect(h.overall).toBe("degraded");
  });

  it("lists the worst first, then by name", () => {
    const h = systemHealth({
      breakers: [
        breaker("gmail"),
        breaker("anthropic", { status: "half_open", retryAt: RETRY }),
        breaker("ats:lever", { status: "open", retryAt: RETRY }),
      ],
      switches: [{ subsystem: "auto_apply", enabled: false, actor: "user", reason: "" }],
      watches: [],
    });
    expect(h.subsystems.map((s) => `${s.health} ${s.subsystem}`)).toEqual([
      "down ats:lever",
      "down auto_apply",
      "degraded anthropic",
      "healthy gmail",
    ]);
  });
});

describe("worker pools (NS-225 slice 3)", () => {
  const pool = (queue: string, secondsSinceSeen: number, enabled = true) => ({
    queue,
    enabled,
    secondsSinceSeen,
  });

  it("shows a pool that beat recently as running", () => {
    expect(systemHealth({ ...NONE, workers: [pool("pipeline", 25)] }).subsystems).toEqual([
      {
        subsystem: "worker:pipeline",
        kind: "worker",
        health: "healthy",
        reason: "Running",
        retryAt: null,
      },
    ]);
  });

  it("shows a pool silent past three minutes as down, saying when it was last seen", () => {
    const h = systemHealth({ ...NONE, workers: [pool("pipeline", 600)] });
    expect([h.overall, h.subsystems[0]?.health, h.subsystems[0]?.reason]).toEqual([
      "degraded",
      "down",
      "Not running: last seen 10 minutes ago",
    ]);
  });

  it("keeps a pool at exactly three minutes running", () => {
    expect(systemHealth({ ...NONE, workers: [pool("pipeline", 180)] }).subsystems[0]?.health).toBe(
      "healthy",
    );
  });

  it("shows a pool Paul turned off as off, not as a fault, however long ago it beat", () => {
    expect(systemHealth({ ...NONE, workers: [pool("apply-browser", 99_999, false)] })).toEqual({
      overall: "healthy",
      subsystems: [
        {
          subsystem: "worker:apply-browser",
          kind: "worker",
          health: "healthy",
          reason: "Turned off in the worker's settings",
          retryAt: null,
        },
      ],
    });
  });

  it("says hours for a pool silent a long time", () => {
    expect(
      systemHealth({ ...NONE, workers: [pool("pipeline", 3 * 3600)] }).subsystems[0]?.reason,
    ).toBe("Not running: last seen 3 hours ago");
  });
});
