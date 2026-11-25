import { createServer, type Server } from "node:http";
import type { ApplicationRow } from "@northstar/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "./config.js";
import { type PipelinePorts, pipelineEndpoints } from "./pipeline.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";
import { portOf, type Sent, send } from "./test/http.js";

// The pipeline endpoints (NS-168) over a real http server, with the database faked. Synthetic
// jobs only.
const HASH = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")
// The real SHA-256 of "test-extension-token", so the token sent below is valid (as in
// capture.test.ts): a 401 proves these session endpoints ignore it.
const EXT_HASH = "2f50a0607c1fb6606c98272169b134502f7c188b1e17f3d1579320aa3e3fb6c4";
const WEB = "http://northstar.localhost:3100";
const T = new Date("2026-11-25T12:00:00Z");
const A1 = "0b6f3f8e-6a55-4c7e-9a52-5d6b2f8a1c01";

const ROW: ApplicationRow = {
  applicationId: A1,
  status: "submitted",
  jobTitle: "Backend Engineer",
  company: "Example Corp",
  ats: "greenhouse",
  createdAt: T,
  updatedAt: T,
};

let server: Server;
let cookie: string;
let ports: PipelinePorts;
let calls: unknown[];

beforeEach(async () => {
  calls = [];
  ports = {
    list: async () => {
      calls.push("list");
      return [ROW];
    },
    timeline: async (id) => {
      calls.push(["timeline", id]);
      if (id !== A1) return null;
      return {
        application: ROW,
        items: [
          {
            occurredAt: T,
            type: "application.submitted",
            actor: "agent:apply",
            line: "Application moved from submitting to submitted",
          },
        ],
      };
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
      extra: pipelineEndpoints({ list: () => ports.list(), timeline: (id) => ports.timeline(id) }),
    }),
  );
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const get = (path: string, withCookie = true): Promise<Sent> =>
  send(server, { method: "GET", path, headers: withCookie ? { cookie } : {} });

const APP_JSON = {
  applicationId: A1,
  status: "submitted",
  jobTitle: "Backend Engineer",
  company: "Example Corp",
  ats: "greenhouse",
  createdAt: "2026-11-25T12:00:00.000Z",
  updatedAt: "2026-11-25T12:00:00.000Z",
};

describe("who may call them", () => {
  it("each endpoint refuses a request without a session with 401 and reads nothing", async () => {
    expect((await get("/applications", false)).status).toBe(401);
    expect((await get(`/applications/timeline?id=${A1}`, false)).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("a valid extension token can't read the pipeline", async () => {
    const bearer = { authorization: "Bearer test-extension-token" };
    const read = (path: string) => send(server, { method: "GET", path, headers: bearer });
    expect([
      (await read("/applications")).status,
      (await read(`/applications/timeline?id=${A1}`)).status,
    ]).toEqual([401, 401]);
    expect(calls).toEqual([]);
  });
});

describe("GET /applications", () => {
  it("lists applications with times as ISO text", async () => {
    const res = await get("/applications");
    expect([res.status, JSON.parse(res.body)]).toEqual([200, { items: [APP_JSON] }]);
  });

  it("answers 503 when the pipeline can't be read", async () => {
    ports.list = async () => {
      throw new Error("database down");
    };
    const res = await get("/applications");
    expect([res.status, JSON.parse(res.body)]).toEqual([503, { error: "unavailable" }]);
  });
});

describe("GET /applications/timeline", () => {
  it("returns the application and its timeline", async () => {
    const res = await get(`/applications/timeline?id=${A1}`);
    expect([res.status, JSON.parse(res.body)]).toEqual([
      200,
      {
        application: APP_JSON,
        items: [
          {
            occurredAt: "2026-11-25T12:00:00.000Z",
            type: "application.submitted",
            actor: "agent:apply",
            line: "Application moved from submitting to submitted",
          },
        ],
      },
    ]);
  });

  it("answers 404 for an application it can't find", async () => {
    const res = await get("/applications/timeline?id=00000000-0000-4000-8000-000000000000");
    expect([res.status, JSON.parse(res.body)]).toEqual([404, { error: "not_found" }]);
  });

  it("refuses an id that isn't a uuid with 400, before reading", async () => {
    expect((await get("/applications/timeline?id=1%20or%201%3D1")).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("answers 503 when the timeline can't be read", async () => {
    ports.timeline = async () => {
      throw new Error("database down");
    };
    expect((await get(`/applications/timeline?id=${A1}`)).status).toBe(503);
  });
});
