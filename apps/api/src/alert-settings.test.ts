import { createServer, type Server } from "node:http";
import type { AlertSettingsChange, StoredAlertSettings } from "@northstar/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AlertSettingsPorts, alertSettingsEndpoints } from "./alert-settings.js";
import type { ApiConfig } from "./config.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";
import { portOf, type Sent, send } from "./test/http.js";

// The alert settings on Settings → Search (NS-199 slice 3) over a real http server, with the
// database faked. Synthetic settings only.
const HASH = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")
const WEB = "http://northstar.localhost:3100";
const DEFAULTS = {
  quiet: { start: 22 * 60, end: 7 * 60 },
  timeZone: "America/New_York",
  tier1InQuietHours: true,
};
const NONE: StoredAlertSettings = { quiet: null, timeZone: null, tier1InQuietHours: null };

let server: Server;
let cookie: string;
let saves: AlertSettingsChange[];
let ports: AlertSettingsPorts;

beforeEach(async () => {
  saves = [];
  let stored: StoredAlertSettings | null = null;
  ports = {
    defaults: { ok: true, value: DEFAULTS },
    read: async () => stored,
    save: async (change) => {
      saves.push(change);
      const next = { ...NONE, ...stored, ...change };
      const saved = JSON.stringify(next) !== JSON.stringify(stored ?? NONE);
      stored = next;
      return { ok: true, value: { saved, settings: next } };
    },
  };
  const sessions = createSessions(() => 0);
  cookie = `ns_session=${sessions.open().token}`;
  server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const config: ApiConfig = { signinKeySha256: HASH, port: portOf(server), webOrigin: WEB };
  server.on(
    "request",
    createApi({
      config,
      sessions,
      // Through `ports` at call time, so a test can swap a port after the server starts.
      extra: alertSettingsEndpoints({
        get defaults() {
          return ports.defaults;
        },
        read: () => ports.read(),
        save: (c) => ports.save(c),
      }),
    }),
  );
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const get = (withCookie = true): Promise<Sent> =>
  send(server, { method: "GET", path: "/settings/alerts", headers: withCookie ? { cookie } : {} });

const post = (body: unknown, withCookie = true): Promise<Sent> =>
  send(server, {
    method: "POST",
    path: "/settings/alerts",
    headers: { "content-type": "application/json", origin: WEB, ...(withCookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

describe("who may call them", () => {
  it("refuses a request without a session with 401, and stores nothing", async () => {
    const read = await get(false);
    const write = await post({ field: "tier1", value: "false" }, false);
    expect([read.status, write.status]).toEqual([401, 401]);
    expect(saves).toEqual([]);
  });
});

describe("reading the settings", () => {
  it("gives the defaults in words when nothing is stored", async () => {
    const res = await get();
    expect([res.status, JSON.parse(res.body)]).toEqual([
      200,
      {
        quiet: "22:00-07:00",
        timeZone: "America/New_York",
        tier1InQuietHours: true,
        sources: { quiet: "default", timeZone: "default", tier1: "default" },
        unknownStoredZone: false,
      },
    ]);
  });

  it("answers 503 when the settings can't be read", async () => {
    ports.read = async () => {
      throw new Error("database down");
    };
    const res = await get();
    expect([res.status, JSON.parse(res.body)]).toEqual([503, { error: "unavailable" }]);
  });

  it("answers 503 on bad ALERT_* defaults, naming no value, and stores nothing", async () => {
    ports.defaults = { ok: false, setting: "ALERT_QUIET_HOURS" };
    const read = await get();
    const write = await post({ field: "tier1", value: "false" });
    expect([read.status, JSON.parse(read.body), write.status, saves]).toEqual([
      503,
      { error: "alert_defaults_invalid" },
      503,
      [],
    ]);
  });
});

describe("changing a setting", () => {
  it("stores a checked value and answers the settings now in effect", async () => {
    const res = await post({ field: "quiet", value: "23:30-06:00" });
    const body = JSON.parse(res.body);
    expect([res.status, body.saved, body.settings.quiet, body.settings.sources.quiet]).toEqual([
      200,
      true,
      "23:30-06:00",
      "stored",
    ]);
    expect(saves).toEqual([{ quiet: { start: 1410, end: 360 } }]);
    expect(JSON.parse((await get()).body).quiet).toBe("23:30-06:00");
  });

  it("refuses a value jobs alerts set would refuse with 400, and stores nothing", async () => {
    const results = [
      await post({ field: "quiet", value: "07:00-07:00" }),
      await post({ field: "zone", value: "Not/AZone" }),
      await post({ field: "tier1", value: "maybe" }),
      await post({ field: "colour", value: "red" }),
    ];
    expect(results.map((r) => r.status)).toEqual([400, 400, 400, 400]);
    expect(JSON.parse(results[0]?.body ?? "{}")).toEqual({ error: "invalid_value" });
    expect(saves).toEqual([]);
  });

  it("puts one setting back to its default on a null value", async () => {
    await post({ field: "zone", value: "Europe/Berlin" });
    const res = await post({ field: "zone", value: null });
    const body = JSON.parse(res.body);
    expect([body.settings.timeZone, body.settings.sources.timeZone, saves.at(-1)]).toEqual([
      "America/New_York",
      "default",
      { timeZone: null },
    ]);
  });

  it("says nothing was saved when the value is already set", async () => {
    await post({ field: "tier1", value: "false" });
    const again = JSON.parse((await post({ field: "tier1", value: "false" })).body);
    expect(again.saved).toBe(false);
  });

  it("answers 503 when the change can't be stored", async () => {
    ports.save = async () => {
      throw new Error("database down");
    };
    const res = await post({ field: "tier1", value: "false" });
    expect([res.status, JSON.parse(res.body)]).toEqual([503, { error: "unavailable" }]);
  });
});
