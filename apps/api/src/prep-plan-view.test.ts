import { createServer, type Server } from "node:http";
import type { PrepPlanView } from "@northstar/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "./config.js";
import { type PrepPlanPorts, prepPlanEndpoints } from "./prep-plan-view.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";
import { portOf, type Sent, send } from "./test/http.js";

// GET /approvals/prep-plan (NS-241 slice 6) over a real http server, with the store faked.
// Invented ids and times only.
const HASH = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")
const EXT_HASH = "2f50a0607c1fb6606c98272169b134502f7c188b1e17f3d1579320aa3e3fb6c4";
const WEB = "http://northstar.localhost:3100";
const R1 = "5b2e9c40-1a3d-4f6e-8b72-9c0d1e2f3a41";
const R2 = "5b2e9c40-1a3d-4f6e-8b72-9c0d1e2f3a42";

// The fake hands back extra fields a stored row might hold: none may reach the response.
const STORED = {
  interview: { start: new Date("2026-12-01T15:00:00Z"), end: new Date("2026-12-01T16:00:00Z") },
  blocks: [
    {
      kind: "prep",
      start: new Date("2026-11-30T09:00:00Z"),
      end: new Date("2026-11-30T09:45:00Z"),
    },
    {
      kind: "warm_up",
      start: new Date("2026-12-01T14:00:00Z"),
      end: new Date("2026-12-01T14:15:00Z"),
    },
  ],
  rescheduled: false,
  calendarEventId: "evtsecret1",
  contentSha256: "a".repeat(64),
} as PrepPlanView;

let server: Server;
let cookie: string;
let calls: string[];
let failing: boolean;

beforeEach(async () => {
  calls = [];
  failing = false;
  const ports: PrepPlanPorts = {
    read: async (requestId) => {
      calls.push(requestId);
      if (failing) throw new Error("database down");
      return requestId === R1 ? STORED : null;
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
      extensionTokenSha256: EXT_HASH,
      extra: prepPlanEndpoints(ports),
    }),
  );
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const get = (query: string, headers: Record<string, string> = { cookie }): Promise<Sent> =>
  send(server, { method: "GET", path: `/approvals/prep-plan${query}`, headers });

describe("GET /approvals/prep-plan", () => {
  it("answers the plan field by field, with no event id or hash", async () => {
    const res = await get(`?requestId=${R1}`);
    expect([
      res.status,
      JSON.parse(res.body),
      res.body.includes("evtsecret1"),
      res.body.includes("aaaa"),
    ]).toEqual([
      200,
      {
        interview: { start: "2026-12-01T15:00:00.000Z", end: "2026-12-01T16:00:00.000Z" },
        blocks: [
          { kind: "prep", start: "2026-11-30T09:00:00.000Z", end: "2026-11-30T09:45:00.000Z" },
          { kind: "warm_up", start: "2026-12-01T14:00:00.000Z", end: "2026-12-01T14:15:00.000Z" },
        ],
        rescheduled: false,
      },
      false,
      false,
    ]);
  });

  it("answers 404 for a request that names no plan of Paul's", async () => {
    const res = await get(`?requestId=${R2}`);
    expect([res.status, JSON.parse(res.body)]).toEqual([404, { error: "not_found" }]);
  });

  it("answers 503 when the store can't be read, never not found", async () => {
    failing = true;
    const res = await get(`?requestId=${R1}`);
    expect([res.status, JSON.parse(res.body)]).toEqual([503, { error: "unavailable" }]);
  });

  it("refuses a malformed id before reading anything", async () => {
    const res = await get("?requestId=not-a-uuid");
    expect([res.status, calls]).toEqual([400, []]);
  });

  it("refuses no session and the extension token with 401, reading nothing", async () => {
    expect([
      (await get(`?requestId=${R1}`, {})).status,
      (await get(`?requestId=${R1}`, { authorization: "Bearer test-extension-token" })).status,
      calls,
    ]).toEqual([401, 401, []]);
  });
});
