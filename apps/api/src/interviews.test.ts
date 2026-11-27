import { createServer, type Server } from "node:http";
import type { FeedNames, StoredInterview } from "@northstar/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "./config.js";
import { type InterviewPorts, interviewEndpoints } from "./interviews.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";
import { portOf, type Sent, send } from "./test/http.js";

// The interview endpoints (NS-240 slice 5) over a real http server, with the store faked.
// Synthetic ids, jobs and companies only.
const HASH = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")
const EXT_HASH = "2f50a0607c1fb6606c98272169b134502f7c188b1e17f3d1579320aa3e3fb6c4";
const WEB = "http://northstar.localhost:3100";
const D1 = "7a1e2a10-6b2c-4f0e-8a51-7c2b9d0e1f01";
const OLD = "7a1e2a10-6b2c-4f0e-8a51-7c2b9d0e1f02";
const DONE = "7a1e2a10-6b2c-4f0e-8a51-7c2b9d0e1f03";
const APP = "3f0c7a52-1d4e-4c8b-9a61-2b7e5d9c0a11";

const STORED: StoredInterview = {
  detectionId: D1,
  applicationId: APP,
  calendarEventId: "evtsecret1",
  format: "technical",
  start: new Date("2026-12-02T15:00:00Z"),
  end: new Date("2026-12-02T16:00:00Z"),
  interviewerCount: 2,
  decision: null,
};

let server: Server;
let cookie: string;
let calls: unknown[];
// When true, the fake store throws, as Postgres down would.
let failing: boolean;

beforeEach(async () => {
  calls = [];
  failing = false;
  const ports: InterviewPorts = {
    list: async () => {
      calls.push("list");
      if (failing) throw new Error("database down");
      return [STORED];
    },
    names: async (aggregates) => {
      calls.push(["names", aggregates]);
      return new Map<string, FeedNames>([
        [`application:${APP}`, { jobTitle: "Platform Engineer", company: "Initech" }],
      ]);
    },
    decide: async (input) => {
      calls.push(["decide", input]);
      if (failing) throw new Error("database down");
      if (input.detectionId === OLD) return { ok: false, error: { kind: "Superseded" } };
      if (input.detectionId === DONE) {
        return { ok: false, error: { kind: "AlreadyDecided", decision: "dismissed" } };
      }
      if (input.detectionId !== D1) return { ok: false, error: { kind: "UnknownDetection" } };
      return { ok: true, value: { recorded: true } };
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
      extra: interviewEndpoints(ports),
    }),
  );
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const get = (headers: Record<string, string> = { cookie }): Promise<Sent> =>
  send(server, { method: "GET", path: "/interviews", headers });

const decide = (body: unknown, headers: Record<string, string> = { cookie }): Promise<Sent> =>
  send(server, {
    method: "POST",
    path: "/interviews/decide",
    headers: { "content-type": "application/json", origin: WEB, ...headers },
    body: JSON.stringify(body),
  });

describe("who may call them", () => {
  it("refuses no session and the extension token with 401, touching nothing", async () => {
    const bearer = { authorization: "Bearer test-extension-token" };
    expect([
      (await get({})).status,
      (await get(bearer)).status,
      (await decide({ detectionId: D1, decision: "confirmed" }, {})).status,
      (await decide({ detectionId: D1, decision: "confirmed" }, bearer)).status,
    ]).toEqual([401, 401, 401, 401]);
    expect(calls).toEqual([]);
  });
});

describe("GET /interviews", () => {
  it("lists detections with the job's own names, never the calendar event id", async () => {
    const res = await get();
    expect([res.status, JSON.parse(res.body), res.body.includes("evtsecret1")]).toEqual([
      200,
      {
        items: [
          {
            detectionId: D1,
            applicationId: APP,
            format: "technical",
            start: "2026-12-02T15:00:00.000Z",
            end: "2026-12-02T16:00:00.000Z",
            interviewerCount: 2,
            decision: null,
            jobTitle: "Platform Engineer",
            company: "Initech",
          },
        ],
      },
      false,
    ]);
  });

  it("answers 503 when the store can't be read, never an empty list", async () => {
    failing = true;
    const res = await get();
    expect([res.status, JSON.parse(res.body)]).toEqual([503, { error: "unavailable" }]);
  });
});

describe("POST /interviews/decide", () => {
  it("records a confirm and answers the decision", async () => {
    const res = await decide({ detectionId: D1, decision: "confirmed" });
    expect([res.status, JSON.parse(res.body), calls]).toEqual([
      200,
      { decision: "confirmed", recorded: true },
      [["decide", { detectionId: D1, decision: "confirmed" }]],
    ]);
  });

  it("answers not_found, superseded and already_decided", async () => {
    const answers = await Promise.all([
      decide({ detectionId: "7a1e2a10-6b2c-4f0e-8a51-7c2b9d0e1f09", decision: "confirmed" }),
      decide({ detectionId: OLD, decision: "confirmed" }),
      decide({ detectionId: DONE, decision: "confirmed" }),
    ]);
    expect(answers.map((a) => [a.status, JSON.parse(a.body)])).toEqual([
      [404, { error: "not_found" }],
      [409, { error: "superseded" }],
      [409, { error: "already_decided" }],
    ]);
  });

  it("refuses any decision but confirm or dismiss, and a malformed id, before any write", async () => {
    const answers = await Promise.all([
      decide({ detectionId: D1, decision: "submitted" }),
      decide({ detectionId: "evt1", decision: "confirmed" }),
    ]);
    expect([answers.map((a) => a.status), calls]).toEqual([[400, 400], []]);
  });

  it("answers 503 when the store can't be written", async () => {
    failing = true;
    const res = await decide({ detectionId: D1, decision: "dismissed" });
    expect([res.status, JSON.parse(res.body)]).toEqual([503, { error: "unavailable" }]);
  });
});
