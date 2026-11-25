import { createServer, type Server } from "node:http";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ApiConfig } from "./config.js";
import { endpoint } from "./endpoint.js";
import { createApi } from "./server.js";
import { createSessions, SESSION_TTL_MS, THROTTLE_LIMIT } from "./sessions.js";
import { portOf, type Sent, send } from "./test/http.js";

// The API on a real http server on a random loopback port. Synthetic key only.
const KEY = "test-key";
const HASH = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256(KEY)
const WEB = "http://northstar.localhost:3100";

const exporter = new InMemorySpanExporter();
beforeAll(() => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});

let server: Server;
let t: number;
let sessions: ReturnType<typeof createSessions>;

// An extra endpoint whose output breaks its own schema, to prove output is checked.
const broken = endpoint({
  method: "GET",
  path: "/test/broken",
  auth: "session",
  input: z.object({}),
  output: z.object({ user: z.literal("paul") }),
  handler: async () => ({ ok: true, body: { user: "someone" } as unknown as { user: "paul" } }),
});

beforeEach(async () => {
  exporter.reset();
  t = 0;
  sessions = createSessions(() => t);
  server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const config: ApiConfig = { signinKeySha256: HASH, port: portOf(server), webOrigin: WEB };
  server.on("request", createApi({ config, sessions, extra: [broken] }));
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const json = { "content-type": "application/json" };

const signIn = (key: string, headers: Record<string, string> = {}) =>
  send(server, {
    method: "POST",
    path: "/auth/sign-in",
    headers: { ...json, origin: WEB, ...headers },
    body: JSON.stringify({ key }),
  });

// The session cookie's name=value part, from a sign-in response.
function cookieOf(res: Sent): string {
  const set = res.headers["set-cookie"];
  const first = Array.isArray(set) ? set[0] : set;
  if (!first) throw new Error("no cookie set");
  return first.split(";")[0] as string;
}

const me = (cookie?: string) =>
  send(server, { method: "GET", path: "/me", headers: cookie ? { cookie } : {} });

describe("GET /me", () => {
  it("refuses a request without a session with 401", async () => {
    const res = await me();
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "unauthenticated" });
  });

  it("answers a signed-in request with Paul", async () => {
    const res = await me(cookieOf(await signIn(KEY)));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ user: "paul" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("refuses a made-up session cookie", async () => {
    expect((await me(`ns_session=${"A".repeat(43)}`)).status).toBe(401);
  });

  it("refuses an expired session", async () => {
    const cookie = cookieOf(await signIn(KEY));
    t += SESSION_TTL_MS;
    expect((await me(cookie)).status).toBe(401);
  });
});

describe("POST /auth/sign-in", () => {
  it("the right key gets an HttpOnly, SameSite=Strict session cookie for 12 hours", async () => {
    const res = await signIn(KEY);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ user: "paul" });
    const set = String(res.headers["set-cookie"]);
    expect(set).toMatch(/^ns_session=[A-Za-z0-9_-]{43}; /);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Strict");
    expect(set).toContain("Path=/");
    expect(set).toContain("Max-Age=43200");
  });

  it("a wrong key gets 401 and no cookie", async () => {
    const res = await signIn("wrong-key");
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "wrong_key" });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("after five wrong keys in a minute, even the right key gets 429", async () => {
    for (let i = 0; i < THROTTLE_LIMIT; i++) await signIn("wrong-key");
    const res = await signIn(KEY);
    expect(res.status).toBe(429);
    expect(JSON.parse(res.body)).toEqual({ error: "throttled" });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses a POST without an Origin with 403", async () => {
    const res = await send(server, {
      method: "POST",
      path: "/auth/sign-in",
      headers: json,
      body: JSON.stringify({ key: KEY }),
    });
    expect(res.status).toBe(403);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses a cross-site Origin with 403", async () => {
    const res = await signIn(KEY, { origin: "https://evil.example.com" });
    expect(res.status).toBe(403);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses a body that isn't JSON with 415", async () => {
    const res = await send(server, {
      method: "POST",
      path: "/auth/sign-in",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: WEB },
      body: `key=${KEY}`,
    });
    expect(res.status).toBe(415);
  });

  it("bad input is 400 with the field's path, never its value", async () => {
    const res = await send(server, {
      method: "POST",
      path: "/auth/sign-in",
      headers: { ...json, origin: WEB },
      body: JSON.stringify({ key: 12345 }),
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_input", paths: ["key"] });
    expect(res.body).not.toContain("12345");
  });

  it("malformed JSON is 400", async () => {
    const res = await send(server, {
      method: "POST",
      path: "/auth/sign-in",
      headers: { ...json, origin: WEB },
      body: "{",
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_json" });
  });

  it("a body over 16 KB is 413, and the connection is closed instead of read to the end", async () => {
    const res = await signIn("x".repeat(17_000));
    expect(res.status).toBe(413);
    expect(res.headers.connection).toBe("close");
  });
});

describe("POST /auth/sign-out", () => {
  it("without a session answers 401 before reading the body, even one over 16 KB", async () => {
    const res = await send(server, {
      method: "POST",
      path: "/auth/sign-out",
      headers: { ...json, origin: WEB },
      body: "x".repeat(17_000),
    });
    expect(res.status).toBe(401);
  });

  it("ends the session and clears the cookie", async () => {
    const cookie = cookieOf(await signIn(KEY));
    const res = await send(server, {
      method: "POST",
      path: "/auth/sign-out",
      headers: { ...json, origin: WEB, cookie },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(String(res.headers["set-cookie"])).toContain("Max-Age=0");
    expect((await me(cookie)).status).toBe(401);
  });
});

describe("every request", () => {
  it("a request the web app proxied for a foreign host is refused with 421 (DNS rebinding)", async () => {
    const res = await send(server, {
      method: "GET",
      path: "/me",
      headers: { "x-forwarded-host": "evil.example.com:3100" },
    });
    expect(res.status).toBe(421);
  });

  it("a request the web app proxied for its own host is accepted", async () => {
    const res = await send(server, {
      method: "GET",
      path: "/me",
      headers: { "x-forwarded-host": "northstar.localhost:3100" },
    });
    expect(res.status).toBe(401);
  });

  it("a foreign Host is refused with 421 (DNS rebinding)", async () => {
    const res = await send(server, {
      method: "GET",
      path: "/me",
      headers: { host: "attacker.example.com" },
    });
    expect(res.status).toBe(421);
  });

  it("localhost on the API's port is accepted as its own host", async () => {
    const res = await send(server, {
      method: "GET",
      path: "/me",
      headers: { host: `localhost:${portOf(server)}` },
    });
    expect(res.status).toBe(401);
  });

  it("an unknown path is 404 and a wrong method is 405", async () => {
    expect((await send(server, { method: "GET", path: "/nope" })).status).toBe(404);
    expect((await send(server, { method: "GET", path: "/auth/sign-in" })).status).toBe(405);
  });

  it("a query string doesn't change the route", async () => {
    expect((await send(server, { method: "GET", path: "/me?x=1" })).status).toBe(401);
  });

  it("output that breaks its schema is 500, never sent", async () => {
    const cookie = cookieOf(await signIn(KEY));
    const res = await send(server, { method: "GET", path: "/test/broken", headers: { cookie } });
    expect(res.status).toBe(500);
    expect(res.body).not.toContain("someone");
  });

  it("gets an api.request span with method, route and status, never the cookie or body", async () => {
    const cookie = cookieOf(await signIn(KEY));
    exporter.reset();
    await me(cookie);
    const spans = exporter.getFinishedSpans().filter((s) => s.name === "api.request");
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes).toEqual({
      "http.request.method": "GET",
      "http.route": "/me",
      "http.response.status_code": 200,
    });
  });

  it("a sign-in span records the outcome, never the key", async () => {
    await signIn("wrong-key");
    const span = exporter.getFinishedSpans().find((s) => s.name === "api.request");
    expect(span?.attributes["northstar.auth.outcome"]).toBe("wrong_key");
    expect(JSON.stringify(span?.attributes)).not.toContain("wrong-key");
  });
});
