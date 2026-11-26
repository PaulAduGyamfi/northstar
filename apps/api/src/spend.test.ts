import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "./config.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";
import { type SpendPorts, spendEndpoints } from "./spend.js";
import { portOf, type Sent, send } from "./test/http.js";

// Model spend on Health (NS-219) over a real http server, with the stored spend faked.
const HASH = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")
const EXT_HASH = "2f50a0607c1fb6606c98272169b134502f7c188b1e17f3d1579320aa3e3fb6c4";
const WEB = "http://northstar.localhost:3100";

let server: Server;
let cookie: string;
let ports: SpendPorts;
let reads: number;

beforeEach(async () => {
  reads = 0;
  ports = {
    caps: { dailyUsd: 5, monthlyUsd: 100 },
    spent: async () => {
      reads++;
      return { todayUsd: 4.2, monthUsd: 31.5 };
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
      // A getter, so a test can swap the ports after the server starts.
      extra: spendEndpoints({
        get caps() {
          return ports.caps;
        },
        spent: () => ports.spent(),
      }),
    }),
  );
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const get = (headers: Record<string, string> = { cookie }): Promise<Sent> =>
  send(server, { method: "GET", path: "/system/spend", headers });

describe("GET /system/spend", () => {
  it("refuses no session and the extension token with 401, reading nothing", async () => {
    expect([
      (await get({})).status,
      (await get({ authorization: "Bearer test-extension-token" })).status,
      reads,
    ]).toEqual([401, 401, 0]);
  });

  it("answers today's and this month's spend, the caps and what is paused", async () => {
    const res = await get();
    expect([res.status, JSON.parse(res.body)]).toEqual([
      200,
      {
        todayUsd: 4.2,
        monthUsd: 31.5,
        dailyCapUsd: 5,
        monthlyCapUsd: 100,
        paused: [{ priority: "low", cap: "daily" }],
      },
    ]);
  });

  it("answers null caps and nothing paused when no cap is set", async () => {
    ports = { ...ports, caps: { dailyUsd: null, monthlyUsd: null } };
    const res = await get();
    expect(JSON.parse(res.body)).toEqual({
      todayUsd: 4.2,
      monthUsd: 31.5,
      dailyCapUsd: null,
      monthlyCapUsd: null,
      paused: [],
    });
  });

  it("answers 503 when spend can't be read", async () => {
    ports = {
      ...ports,
      spent: async () => {
        throw new Error("database down");
      },
    };
    const res = await get();
    expect([res.status, JSON.parse(res.body)]).toEqual([503, { error: "unavailable" }]);
  });
});
