import { createServer, type Server } from "node:http";
import type { GrowthTrackView, StoredCheckIn, StoredReview } from "@northstar/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "./config.js";
import { type GrowthPorts, growthEndpoints } from "./growth.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";
import { portOf, type Sent, send } from "./test/http.js";

// The Grow tab's endpoints (NS-214) over a real http server, with the database faked. Invented
// tracks only.
const HASH = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")
const EXT_HASH = "2f50a0607c1fb6606c98272169b134502f7c188b1e17f3d1579320aa3e3fb6c4";
const WEB = "http://northstar.localhost:3100";
// A Thursday: this week starts 2026-11-23, last week 2026-11-16.
const NOW = new Date("2026-11-26T12:00:00Z");

const TRACKS: GrowthTrackView[] = [
  {
    key: "cloud-cert",
    name: "Cloud certification",
    type: "cert",
    status: "active",
    priority: 4,
    target: null,
    untouchedDays: 7,
    next: { title: "Practice exam 1", minutes: 60 },
    lastTouchedAt: null,
  },
  {
    key: "side-app",
    name: "Budget app",
    type: "project",
    status: "active",
    priority: 2,
    target: null,
    untouchedDays: 14,
    next: { title: "Write the import", minutes: 45 },
    lastTouchedAt: null,
  },
];

const PLAN = {
  focus: [{ trackId: "cloud-cert", blocks: [60, 60] }],
  maintenance: [{ trackId: "side-app", blocks: [30] }],
  atRisk: [],
  needsNextAction: [],
  notes: [],
  unplanned: [],
};

let server: Server;
let cookie: string;
let calls: unknown[];
let checkIns: StoredCheckIn[];
let plans: Map<string, Record<string, unknown>>;
let reviews: Map<string, StoredReview>;
let tracks: GrowthTrackView[] | null;

beforeEach(async () => {
  calls = [];
  checkIns = [];
  plans = new Map([["2026-11-23", PLAN]]);
  reviews = new Map();
  tracks = TRACKS;
  const ports: GrowthPorts = {
    now: () => NOW,
    tracks: async () => {
      calls.push("tracks");
      return tracks === null ? null : { version: 1, tracks };
    },
    settings: async () => null,
    plan: async (week) => {
      const plan = plans.get(week);
      return plan ? { plan } : null;
    },
    checkIns: async (since) => checkIns.filter((c) => c.at >= since),
    review: async (week) => reviews.get(week) ?? null,
    recordCheckIn: async (input) => {
      calls.push(["recordCheckIn", input]);
      if (!TRACKS.some((t) => t.key === input.key)) {
        return { ok: false, error: { kind: "UnknownTrack" } };
      }
      if (input.idempotencyKey === "already-stored") return { ok: true, status: "replayed" };
      checkIns.push({ key: input.key, at: NOW, minutes: input.minutes, percent: input.percent });
      return { ok: true, status: "recorded" };
    },
    saveReview: async (input) => {
      calls.push(["saveReview", input]);
      const existing = reviews.get(input.weekStart);
      if (existing) return existing;
      const stored = {
        weekStart: input.weekStart,
        moved: input.moved,
        notReached: input.notReached,
      };
      reviews.set(input.weekStart, stored);
      return stored;
    },
  };
  const sessions = createSessions(() => 0);
  cookie = `ns_session=${sessions.open().token}`;
  server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const config: ApiConfig = { signinKeySha256: HASH, port: portOf(server), webOrigin: WEB };
  server.on(
    "request",
    createApi({ config, sessions, extensionTokenSha256: EXT_HASH, extra: growthEndpoints(ports) }),
  );
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const get = (path: string, withCookie = true): Promise<Sent> =>
  send(server, { method: "GET", path, headers: withCookie ? { cookie } : {} });

const post = (path: string, body: unknown, withCookie = true): Promise<Sent> =>
  send(server, {
    method: "POST",
    path,
    headers: {
      "content-type": "application/json",
      origin: WEB,
      ...(withCookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });

const CHECK_IN = { key: "cloud-cert", minutes: 45, percent: 30, idempotencyKey: "form-0001" };

describe("who may call them", () => {
  it("refuses each endpoint without a session with 401, touching nothing", async () => {
    expect([
      (await get("/growth", false)).status,
      (await post("/growth/check-ins", CHECK_IN, false)).status,
      (await post("/growth/review", {}, false)).status,
    ]).toEqual([401, 401, 401]);
    expect(calls).toEqual([]);
  });
});

describe("who may call them, beyond a session", () => {
  it("refuses a valid extension token on every endpoint", async () => {
    const bearer = { authorization: "Bearer test-extension-token" };
    const call = (method: string, path: string) =>
      send(server, {
        method,
        path,
        headers: { ...bearer, "content-type": "application/json", origin: WEB },
        ...(method === "POST" ? { body: JSON.stringify(CHECK_IN) } : {}),
      });
    expect([
      (await call("GET", "/growth")).status,
      (await call("POST", "/growth/check-ins")).status,
      (await call("POST", "/growth/review")).status,
    ]).toEqual([401, 401, 401]);
    expect(calls).toEqual([]);
  });

  it("refuses a check-in from another origin, storing nothing", async () => {
    const res = await send(server, {
      method: "POST",
      path: "/growth/check-ins",
      headers: { "content-type": "application/json", origin: "https://evil.example.com", cookie },
      body: JSON.stringify(CHECK_IN),
    });
    expect([res.status, checkIns.length]).toEqual([403, 0]);
  });
});

describe("GET /growth", () => {
  it("gives each track's figures for this week from the stored plan", async () => {
    const res = await get("/growth");
    const body = JSON.parse(res.body);
    expect([res.status, body.weekStart, body.planStored, body.tracks]).toEqual([
      200,
      "2026-11-23",
      true,
      [
        {
          key: "cloud-cert",
          name: "Cloud certification",
          type: "cert",
          status: "active",
          minutesThisWeek: 0,
          plannedMinutes: 120,
          daysSinceTouched: null,
          atRisk: true,
          streakWeeks: 0,
          percent: null,
          percentPerWeekNeeded: null,
        },
        {
          key: "side-app",
          name: "Budget app",
          type: "project",
          status: "active",
          minutesThisWeek: 0,
          plannedMinutes: 30,
          daysSinceTouched: null,
          atRisk: true,
          streakWeeks: 0,
          percent: null,
          percentPerWeekNeeded: null,
        },
      ],
    ]);
  });

  it("previews the plan when none is stored for this week, storing nothing", async () => {
    plans.clear();
    const body = JSON.parse((await get("/growth")).body);
    expect([
      body.planStored,
      body.tracks.map((t: { plannedMinutes: number }) => t.plannedMinutes > 0),
    ]).toEqual([false, [true, true]]);
  });

  it("is empty with no tracks yet", async () => {
    tracks = null;
    const body = JSON.parse((await get("/growth")).body);
    expect([body.tracks, body.lastWeek]).toEqual([[], { weekStart: "2026-11-16", review: null }]);
  });
});

describe("POST /growth/check-ins", () => {
  it("records a check-in that shows on the dashboard at once", async () => {
    const res = await post("/growth/check-ins", CHECK_IN);
    const row = JSON.parse((await get("/growth")).body).tracks[0];
    expect([
      res.status,
      JSON.parse(res.body),
      row.minutesThisWeek,
      row.percent,
      row.daysSinceTouched,
      row.streakWeeks,
    ]).toEqual([200, { status: "recorded" }, 45, 30, 0, 1]);
  });

  it("passes the write path's replay through", async () => {
    const res = await post("/growth/check-ins", { ...CHECK_IN, idempotencyKey: "already-stored" });
    expect([res.status, JSON.parse(res.body)]).toEqual([200, { status: "replayed" }]);
  });

  it("answers an unknown track with unknown_track", async () => {
    const res = await post("/growth/check-ins", { ...CHECK_IN, key: "nope" });
    expect([res.status, JSON.parse(res.body)]).toEqual([404, { error: "unknown_track" }]);
  });

  it("refuses minutes outside 1–600 before any write", async () => {
    const res = await post("/growth/check-ins", { ...CHECK_IN, minutes: 0 });
    expect([res.status, calls.filter((c) => Array.isArray(c))]).toEqual([400, []]);
  });
});

describe("POST /growth/review", () => {
  it("answers no_plan when last week has no stored plan", async () => {
    const res = await post("/growth/review", {});
    expect([res.status, JSON.parse(res.body)]).toEqual([409, { error: "no_plan" }]);
  });

  it("keeps time logged on a track removed since, never calling it not reached", async () => {
    plans.set("2026-11-16", PLAN);
    checkIns.push({
      key: "side-app",
      at: new Date("2026-11-18T09:00:00Z"),
      minutes: 20,
      percent: null,
    });
    tracks = [TRACKS[0] as GrowthTrackView];
    const body = JSON.parse((await post("/growth/review", {})).body);
    expect([body.moved, body.notReached]).toEqual([
      [{ key: "side-app", name: null, minutes: 20, plannedMinutes: 30 }],
      [{ key: "cloud-cert", name: "Cloud certification" }],
    ]);
  });

  it("reviews last week from its plan and check-ins, storing keys only", async () => {
    plans.set("2026-11-16", PLAN);
    checkIns.push({
      key: "cloud-cert",
      at: new Date("2026-11-18T09:00:00Z"),
      minutes: 50,
      percent: null,
    });
    const res = await post("/growth/review", {});
    const shown = await get("/growth");
    expect([
      res.status,
      JSON.parse(res.body),
      calls.find((c) => Array.isArray(c) && c[0] === "saveReview"),
      JSON.parse(shown.body).lastWeek.review.weekStart,
    ]).toEqual([
      200,
      {
        weekStart: "2026-11-16",
        moved: [
          { key: "cloud-cert", name: "Cloud certification", minutes: 50, plannedMinutes: 120 },
        ],
        notReached: [{ key: "side-app", name: "Budget app" }],
      },
      [
        "saveReview",
        {
          weekStart: "2026-11-16",
          moved: [{ key: "cloud-cert", minutes: 50, plannedMinutes: 120 }],
          notReached: ["side-app"],
        },
      ],
      "2026-11-16",
    ]);
  });
});
