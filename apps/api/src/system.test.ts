import { createServer, type Server } from "node:http";
import type { FeedItem, SetKillSwitchResult } from "@northstar/db";
import type { SystemHealth } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "./config.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";
import { type SystemPorts, systemEndpoints } from "./system.js";
import { portOf, type Sent, send } from "./test/http.js";

// The System Health, feed and kill-switch endpoints over a real http server, with the database
// faked. Synthetic subsystems and lines only.
const HASH = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")
const WEB = "http://northstar.localhost:3100";
const T = new Date("2026-11-25T12:00:00Z");

const item = (position: bigint, line: string): FeedItem => ({
  position,
  occurredAt: T,
  type: "kill_switch.set",
  actor: "user",
  line,
});

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

beforeEach(async () => {
  calls = [];
  health = async () => HEALTH;
  switchResult = { ok: true, changed: true };
  const ports: SystemPorts = {
    health: () => health(),
    feedBefore: async (before, limit) => {
      calls.push(["before", before, limit]);
      return [item(9n, "You switched off auto_apply"), item(8n, "Paused anthropic")];
    },
    feedAfter: async (after, limit) => {
      calls.push(["after", after, limit]);
      return [item(10n, "You switched on auto_apply")];
    },
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

  it("answers 503 when the state can't be read", async () => {
    health = async () => {
      throw new Error("database down");
    };
    const res = await get("/system/health");
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: "unavailable" });
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
        },
        {
          position: "8",
          occurredAt: "2026-11-25T12:00:00.000Z",
          type: "kill_switch.set",
          actor: "user",
          line: "Paused anthropic",
        },
      ],
    });
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
});

describe("POST /system/kill-switches", () => {
  it("flips a switch with Paul's reason", async () => {
    const res = await flip({ subsystem: "auto_apply", enabled: false, reason: "On holiday" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ changed: true });
    expect(calls).toEqual([
      ["switch", { subsystem: "auto_apply", enabled: false, reason: "On holiday" }],
    ]);
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
