import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "./config.js";
import { loadPushPublicKey } from "./config.js";
import { type PushPorts, pushEndpoints } from "./push.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";
import { portOf, type Sent, send } from "./test/http.js";

// The push subscription endpoints (NS-193 slice 2) over a real http server, with the store faked.
// Synthetic endpoints and keys only.
const HASH = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")
const EXT_HASH = "2f50a0607c1fb6606c98272169b134502f7c188b1e17f3d1579320aa3e3fb6c4";
const WEB = "http://northstar.localhost:3100";
const PUBLIC_KEY = `B${"A".repeat(86)}`;
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/device-1";
const KEYS = { p256dh: `B${"C".repeat(86)}`, auth: "D".repeat(22) };

let server: Server;
let cookie: string;
let calls: unknown[];
let failing: boolean;
let publicKey: string | null;

async function start() {
  const ports: PushPorts = {
    publicKey,
    count: async () => {
      calls.push("count");
      if (failing) throw new Error("database down");
      return 2;
    },
    subscribe: async (input) => {
      calls.push(["subscribe", input]);
      if (failing) throw new Error("database down");
      return { ok: true, subscriptionId: "sub-1", created: true };
    },
    unsubscribe: async (endpoint) => {
      calls.push(["unsubscribe", endpoint]);
      if (failing) throw new Error("database down");
      return { ok: true, removed: true };
    },
  };
  const sessions = createSessions(() => 0);
  cookie = `ns_session=${sessions.open().token}`;
  server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const config: ApiConfig = { signinKeySha256: HASH, port: portOf(server), webOrigin: WEB };
  server.on(
    "request",
    createApi({ config, sessions, extensionTokenSha256: EXT_HASH, extra: pushEndpoints(ports) }),
  );
}

beforeEach(async () => {
  calls = [];
  failing = false;
  publicKey = PUBLIC_KEY;
  await start();
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const getKey = (headers: Record<string, string> = { cookie }): Promise<Sent> =>
  send(server, { method: "GET", path: "/push/key", headers });

const post = (path: string, body: unknown, headers: Record<string, string> = { cookie }) =>
  send(server, {
    method: "POST",
    path,
    headers: { "content-type": "application/json", origin: WEB, ...headers },
    body: JSON.stringify(body),
  });

const subscription = { endpoint: ENDPOINT, keys: KEYS };

describe("who may call them", () => {
  it("refuses no session and the extension token with 401, storing nothing", async () => {
    const bearer = { authorization: "Bearer test-extension-token" };
    expect([
      (await getKey({})).status,
      (await getKey(bearer)).status,
      (await post("/push/subscribe", subscription, {})).status,
      (await post("/push/subscribe", subscription, bearer)).status,
      (await post("/push/unsubscribe", { endpoint: ENDPOINT }, {})).status,
    ]).toEqual([401, 401, 401, 401, 401]);
    expect(calls).toEqual([]);
  });
});

describe("GET /push/key (NS-193 slice 2)", () => {
  it("gives the public key and how many browsers have notifications on", async () => {
    const res = await getKey();
    expect([res.status, JSON.parse(res.body)]).toEqual([
      200,
      { publicKey: PUBLIC_KEY, subscriptions: 2 },
    ]);
  });

  it("says the count is unknown when it can't be read, never 0", async () => {
    failing = true;
    expect(JSON.parse((await getKey()).body)).toEqual({
      publicKey: PUBLIC_KEY,
      subscriptions: null,
    });
  });
});

describe("POST /push/subscribe (NS-193 slice 2)", () => {
  it("stores Paul's subscription", async () => {
    const res = await post("/push/subscribe", subscription);
    expect([res.status, JSON.parse(res.body), calls]).toEqual([
      200,
      { created: true },
      [["subscribe", { endpoint: ENDPOINT, ...KEYS }]],
    ]);
  });

  it("refuses an endpoint outside the push allowlist before touching the store", async () => {
    const res = await post("/push/subscribe", {
      endpoint: "https://169.254.169.254/latest/meta-data",
      keys: KEYS,
    });
    expect([res.status, JSON.parse(res.body), calls]).toEqual([
      400,
      { error: "endpoint_not_allowed" },
      [],
    ]);
  });

  it("refuses a subscription while push isn't set up", async () => {
    await new Promise<void>((done) => server.close(() => done()));
    publicKey = null;
    await start();
    const res = await post("/push/subscribe", subscription);
    expect([res.status, JSON.parse(res.body), calls]).toEqual([
      409,
      { error: "push_not_set_up" },
      [],
    ]);
  });

  it("answers 503 when the store fails", async () => {
    failing = true;
    expect((await post("/push/subscribe", subscription)).status).toBe(503);
  });
});

describe("POST /push/unsubscribe (NS-193 slice 2)", () => {
  it("removes the browser's subscription by its endpoint", async () => {
    const res = await post("/push/unsubscribe", { endpoint: ENDPOINT });
    expect([res.status, JSON.parse(res.body), calls]).toEqual([
      200,
      { removed: true },
      [["unsubscribe", ENDPOINT]],
    ]);
  });
});

describe("loadPushPublicKey (NS-193)", () => {
  it("is null while unset or a placeholder", () => {
    expect([
      loadPushPublicKey({}),
      loadPushPublicKey({ PUSH_VAPID_PUBLIC_KEY: "change-me" }),
    ]).toEqual([null, null]);
  });

  it("refuses a value that isn't a P-256 public key, without printing it", () => {
    expect(() => loadPushPublicKey({ PUSH_VAPID_PUBLIC_KEY: "not-a-key" })).toThrow(
      "PUSH_VAPID_PUBLIC_KEY must be a P-256 public key in base64url (87 characters)",
    );
  });

  it("never reads the private key", () => {
    expect(
      loadPushPublicKey({ PUSH_VAPID_PUBLIC_KEY: PUBLIC_KEY, PUSH_VAPID_PRIVATE_KEY: "x" }),
    ).toBe(PUBLIC_KEY);
  });
});
