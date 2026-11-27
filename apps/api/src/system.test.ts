import { createServer, type Server } from "node:http";
import type { FeedItem, SetKillSwitchResult } from "@northstar/db";
import type { SystemHealth } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiConfig } from "./config.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";
import { errorFacts, type SystemPorts, systemEndpoints } from "./system.js";
import { portOf, type Sent, send } from "./test/http.js";

// The System Health, feed and kill-switch endpoints over a real http server, with the database
// faked. Synthetic subsystems and lines only.
const HASH = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")
const WEB = "http://northstar.localhost:3100";
const T = new Date("2026-11-25T12:00:00Z");

const item = (position: bigint, line: string, aggregate = "kill_switch:k1"): FeedItem => ({
  position,
  occurredAt: T,
  type: "kill_switch.set",
  actor: "user",
  line,
  aggregate,
});

// Synthetic job and application aggregates the fake names port knows (NS-189).
const JOB = "job:00000000-0000-4000-8000-000000000001";
const APP = "application:00000000-0000-4000-8000-000000000002";

const HEALTH: SystemHealth = {
  overall: "degraded",
  subsystems: [
    {
      subsystem: "anthropic",
      kind: "dependency",
      health: "down",
      reason: "Paused after repeated failures (RateLimited)",
      retryAt: T,
    },
    { subsystem: "gmail", kind: "dependency", health: "healthy", reason: "Working", retryAt: null },
  ],
};

let server: Server;
let cookie: string;
let calls: unknown[];
let health: () => Promise<SystemHealth>;
let switchResult: SetKillSwitchResult;
let page: FeedItem[];
let feedNames: SystemPorts["feedNames"];

beforeEach(async () => {
  calls = [];
  health = async () => HEALTH;
  switchResult = { ok: true, changed: true };
  page = [item(9n, "You switched off auto_apply"), item(8n, "Paused anthropic")];
  feedNames = async () => new Map();
  const ports: SystemPorts = {
    health: () => health(),
    feedBefore: async (before, limit) => {
      calls.push(["before", before, limit]);
      return page;
    },
    feedAfter: async (after, limit) => {
      calls.push(["after", after, limit]);
      return [item(10n, "You switched on auto_apply")];
    },
    feedNames: (aggregates) => feedNames(aggregates),
    setSwitch: async (input) => {
      calls.push(["switch", input]);
      return switchResult;
    },
  };
  const sessions = createSessions(() => 0);
  cookie = `ns_session=${sessions.open().token}`;
  server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const config: ApiConfig = { signinKeySha256: HASH, port: portOf(server), webOrigin: WEB };
  server.on("request", createApi({ config, sessions, extra: systemEndpoints(ports) }));
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const get = (path: string, withCookie = true): Promise<Sent> =>
  send(server, { method: "GET", path, headers: withCookie ? { cookie } : {} });

const flip = (body: unknown, withCookie = true): Promise<Sent> =>
  send(server, {
    method: "POST",
    path: "/system/kill-switches",
    headers: {
      "content-type": "application/json",
      origin: WEB,
      ...(withCookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });

describe("who may call them", () => {
  it("each endpoint refuses a request without a session with 401", async () => {
    expect((await get("/system/health", false)).status).toBe(401);
    expect((await get("/feed", false)).status).toBe(401);
    expect(
      (await flip({ subsystem: "auto_apply", enabled: false, reason: "x" }, false)).status,
    ).toBe(401);
    expect(calls).toEqual([]);
  });
});

describe("GET /system/health", () => {
  it("returns the health model with times as ISO text", async () => {
    const res = await get("/system/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      overall: "degraded",
      subsystems: [
        {
          subsystem: "anthropic",
          kind: "dependency",
          health: "down",
          reason: "Paused after repeated failures (RateLimited)",
          retryAt: "2026-11-25T12:00:00.000Z",
        },
        {
          subsystem: "gmail",
          kind: "dependency",
          health: "healthy",
          reason: "Working",
          retryAt: null,
        },
      ],
    });
  });

  it("passes a worker pool's health through (NS-225 slice 3)", async () => {
    health = async () => ({
      overall: "degraded",
      subsystems: [
        {
          subsystem: "worker:pipeline",
          kind: "worker",
          health: "down",
          reason: "Not running: last seen 10 minutes ago",
          retryAt: null,
        },
      ],
    });
    const res = await get("/system/health");
    expect([res.status, JSON.parse(res.body).subsystems[0].kind]).toEqual([200, "worker"]);
  });

  it("answers 503 when the state can't be read", async () => {
    health = async () => {
      throw new Error("database down");
    };
    const res = await get("/system/health");
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: "unavailable" });
  });

  it("logs why the state can't be read as the error's class and code, never its message", async () => {
    health = async () => {
      throw Object.assign(new Error("password for postgres://u:secret@host failed"), {
        code: "28P01",
      });
    };
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: string) => {
      lines.push(line);
    });
    try {
      await get("/system/health");
    } finally {
      spy.mockRestore();
    }
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { level: "error", msg: "health read failed", error: "Error", code: "28P01" },
    ]);
  });
});

describe("errorFacts", () => {
  it("drops a code that isn't a short plain token", () => {
    expect(errorFacts(Object.assign(new TypeError("x"), { code: "a b; secret" }))).toEqual({
      error: "TypeError",
    });
  });
});

describe("GET /feed", () => {
  it("returns the newest page with positions as text", async () => {
    const res = await get("/feed");
    expect(JSON.parse(res.body)).toEqual({
      items: [
        {
          position: "9",
          occurredAt: "2026-11-25T12:00:00.000Z",
          type: "kill_switch.set",
          actor: "user",
          line: "You switched off auto_apply",
          jobTitle: null,
          company: null,
        },
        {
          position: "8",
          occurredAt: "2026-11-25T12:00:00.000Z",
          type: "kill_switch.set",
          actor: "user",
          line: "Paused anthropic",
          jobTitle: null,
          company: null,
        },
      ],
    });
    expect(calls).toEqual([["before", undefined, 20]]);
  });

  it("returns each line's job title and company as their own fields, leaving the line as it was", async () => {
    page = [item(9n, "Scored a job 91", JOB), item(8n, "Queued an application", APP)];
    feedNames = async (aggregates) => {
      calls.push(["names", aggregates]);
      return new Map([
        [JOB, { jobTitle: "Backend Engineer", company: "Example Corp" }],
        [APP, { jobTitle: "Data Engineer", company: null }],
      ]);
    };
    const res = await get("/feed");
    const items = JSON.parse(res.body).items;
    expect(items.map((i: Record<string, unknown>) => [i.line, i.jobTitle, i.company])).toEqual([
      ["Scored a job 91", "Backend Engineer", "Example Corp"],
      ["Queued an application", "Data Engineer", null],
    ]);
    expect(calls).toEqual([
      ["before", undefined, 20],
      ["names", [JOB, APP]],
    ]);
  });

  it("never returns the aggregate id itself", async () => {
    page = [item(9n, "Scored a job 91", JOB)];
    const res = await get("/feed");
    expect(res.body).not.toContain(JOB.slice(4));
    expect(Object.keys(JSON.parse(res.body).items[0])).not.toContain("aggregate");
  });

  it("still returns the lines, without names, when the names can't be read", async () => {
    page = [item(9n, "Scored a job 91", JOB)];
    feedNames = async () => {
      throw new Error("database unavailable");
    };
    const res = await get("/feed");
    expect(res.status).toBe(200);
    expect(
      JSON.parse(res.body).items.map((i: Record<string, unknown>) => [
        i.line,
        i.jobTitle,
        i.company,
      ]),
    ).toEqual([["Scored a job 91", null, null]]);
  });

  it("doesn't ask for names when the page is empty", async () => {
    page = [];
    feedNames = async (aggregates) => {
      calls.push(["names", aggregates]);
      return new Map();
    };
    await get("/feed");
    expect(calls).toEqual([["before", undefined, 20]]);
  });

  it("pages backwards from a position", async () => {
    await get("/feed?before=8&limit=10");
    expect(calls).toEqual([["before", 8n, 10]]);
  });

  it("reads what is new after a position", async () => {
    const res = await get("/feed?after=9");
    expect(JSON.parse(res.body).items.map((i: { position: string }) => i.position)).toEqual(["10"]);
    expect(calls).toEqual([["after", 9n, 20]]);
  });

  it("refuses before and after together with 400", async () => {
    expect((await get("/feed?before=8&after=9")).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("refuses a position that isn't a whole number with 400", async () => {
    expect((await get("/feed?after=9x")).status).toBe(400);
  });

  it("refuses a page over 50 with 400", async () => {
    expect((await get("/feed?limit=51")).status).toBe(400);
  });

  it("refuses a position past the largest log position with 400, before the database", async () => {
    expect((await get("/feed?after=9223372036854775808")).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("accepts the largest log position", async () => {
    expect((await get("/feed?after=9223372036854775807")).status).toBe(200);
  });
});

describe("POST /system/kill-switches", () => {
  it("flips a switch with Paul's reason", async () => {
    const res = await flip({ subsystem: "auto_apply", enabled: false, reason: "On holiday" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ changed: true });
    expect(calls).toEqual([
      ["switch", { subsystem: "auto_apply", enabled: false, reason: "On holiday", actor: "user" }],
    ]);
  });

  it("records the flip as Paul's even when the request names another actor", async () => {
    await flip({ subsystem: "auto_apply", enabled: false, reason: "x", actor: "system" });
    expect(calls).toEqual([
      ["switch", { subsystem: "auto_apply", enabled: false, reason: "x", actor: "user" }],
    ]);
  });

  it("refuses a flip from another site's page with 403, even with the session", async () => {
    const res = await send(server, {
      method: "POST",
      path: "/system/kill-switches",
      headers: { "content-type": "application/json", origin: "https://evil.example.com", cookie },
      body: JSON.stringify({ subsystem: "auto_apply", enabled: false, reason: "x" }),
    });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("refuses a flip carrying only a Bearer token with 401", async () => {
    const res = await send(server, {
      method: "POST",
      path: "/system/kill-switches",
      headers: {
        "content-type": "application/json",
        origin: WEB,
        authorization: "Bearer test-extension-token",
      },
      body: JSON.stringify({ subsystem: "auto_apply", enabled: false, reason: "x" }),
    });
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("refuses an unknown subsystem with 400", async () => {
    switchResult = { ok: false, error: { kind: "InvalidSubsystem" } };
    const res = await flip({ subsystem: "everything", enabled: false, reason: "x" });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_subsystem" });
  });

  it("refuses an empty reason with 400", async () => {
    switchResult = { ok: false, error: { kind: "ReasonRequired" } };
    const res = await flip({ subsystem: "auto_apply", enabled: false, reason: " " });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "reason_required" });
  });
});
