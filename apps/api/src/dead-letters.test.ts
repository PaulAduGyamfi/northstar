import { createServer, type Server } from "node:http";
import type { DeadLetterView } from "@northstar/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "./config.js";
import { type DeadLetterPorts, deadLetterEndpoints } from "./dead-letters.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";
import { portOf, type Sent, send } from "./test/http.js";

// The dead-letter endpoints (NS-215) over a real http server, with the store faked. Synthetic ids.
const HASH = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")
const EXT_HASH = "2f50a0607c1fb6606c98272169b134502f7c188b1e17f3d1579320aa3e3fb6c4";
const WEB = "http://northstar.localhost:3100";
const L1 = "4d1e2a10-6b2c-4f0e-8a51-7c2b9d0e1f01";
const RESOLVED = "4d1e2a10-6b2c-4f0e-8a51-7c2b9d0e1f02";

const LETTER: DeadLetterView = {
  deadLetterId: L1,
  kind: "apply.stale_sweep",
  subject: "candidate:00000000-0000-4000-8000-000000000001",
  reasonCode: "sweep_failed",
  attempts: 3,
  deadAt: new Date("2026-11-26T12:00:00Z"),
};

let server: Server;
let cookie: string;
let calls: unknown[];

beforeEach(async () => {
  calls = [];
  const ports: DeadLetterPorts = {
    list: async () => {
      calls.push("list");
      return [LETTER];
    },
    resolve: async (input) => {
      calls.push(["resolve", input]);
      if (input.deadLetterId === RESOLVED) return { ok: false, error: { kind: "AlreadyResolved" } };
      if (input.deadLetterId !== L1) return { ok: false, error: { kind: "NotFound" } };
      return { ok: true, value: { kind: LETTER.kind, subject: LETTER.subject } };
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
      extra: deadLetterEndpoints(ports),
    }),
  );
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const get = (path: string, headers: Record<string, string> = { cookie }): Promise<Sent> =>
  send(server, { method: "GET", path, headers });

const resolve = (body: unknown, headers: Record<string, string> = { cookie }): Promise<Sent> =>
  send(server, {
    method: "POST",
    path: "/dead-letters/resolve",
    headers: { "content-type": "application/json", origin: WEB, ...headers },
    body: JSON.stringify(body),
  });

describe("who may call them", () => {
  it("refuses no session and the extension token with 401, touching nothing", async () => {
    const bearer = { authorization: "Bearer test-extension-token" };
    expect([
      (await get("/dead-letters", {})).status,
      (await get("/dead-letters", bearer)).status,
      (await resolve({ deadLetterId: L1, action: "retry" }, {})).status,
      (await resolve({ deadLetterId: L1, action: "retry" }, bearer)).status,
    ]).toEqual([401, 401, 401, 401]);
    expect(calls).toEqual([]);
  });
});

describe("GET /dead-letters", () => {
  it("lists open letters without their subject", async () => {
    const res = await get("/dead-letters");
    expect([res.status, JSON.parse(res.body), res.body.includes("candidate:")]).toEqual([
      200,
      {
        items: [
          {
            deadLetterId: L1,
            kind: "apply.stale_sweep",
            reasonCode: "sweep_failed",
            attempts: 3,
            deadAt: "2026-11-26T12:00:00.000Z",
          },
        ],
      },
      false,
    ]);
  });
});

describe("POST /dead-letters/resolve", () => {
  it("resolves as Paul whatever the body says, and answers the kind and action", async () => {
    const res = await resolve({ deadLetterId: L1, action: "retry", actor: "system" });
    expect([res.status, JSON.parse(res.body), calls]).toEqual([
      200,
      { kind: "apply.stale_sweep", action: "retry" },
      [["resolve", { deadLetterId: L1, action: "retry", actor: "user" }]],
    ]);
  });

  it("answers not_found and already_resolved", async () => {
    const missing = await resolve({
      deadLetterId: "4d1e2a10-6b2c-4f0e-8a51-7c2b9d0e1f09",
      action: "skip",
    });
    const twice = await resolve({ deadLetterId: RESOLVED, action: "skip" });
    expect([
      [missing.status, JSON.parse(missing.body)],
      [twice.status, JSON.parse(twice.body)],
    ]).toEqual([
      [404, { error: "not_found" }],
      [409, { error: "already_resolved" }],
    ]);
  });

  it("refuses an unknown action before any write", async () => {
    const res = await resolve({ deadLetterId: L1, action: "delete" });
    expect([res.status, calls]).toEqual([400, []]);
  });
});
