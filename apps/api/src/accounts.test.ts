import { createServer, type Server } from "node:http";
import type { TenantView } from "@northstar/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AccountsPorts, accountsEndpoints } from "./accounts.js";
import type { ApiConfig } from "./config.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";
import { portOf, type Sent, send } from "./test/http.js";

// GET /accounts (NS-124, ACC-001) over a real http server, with the database faked. Synthetic
// tenants only.
const HASH = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")
const WEB = "http://northstar.localhost:3100";
const T = new Date("2026-11-25T12:00:00Z");

const TENANTS: TenantView[] = [
  { tenantKey: "workday:globex", ats: "workday", status: "active", createdAt: T, changedAt: T },
  { tenantKey: "workday:initech", ats: "workday", status: "none", createdAt: T, changedAt: null },
];

let server: Server;
let cookie: string;
let list: () => Promise<TenantView[]>;

beforeEach(async () => {
  list = async () => TENANTS;
  const ports: AccountsPorts = { listTenants: () => list() };
  const sessions = createSessions(() => 0);
  cookie = `ns_session=${sessions.open().token}`;
  server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const config: ApiConfig = { signinKeySha256: HASH, port: portOf(server), webOrigin: WEB };
  server.on("request", createApi({ config, sessions, extra: accountsEndpoints(ports) }));
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const get = (withCookie = true): Promise<Sent> =>
  send(server, { method: "GET", path: "/accounts", headers: withCookie ? { cookie } : {} });

describe("GET /accounts", () => {
  it("refuses a request without a session with 401", async () => {
    expect((await get(false)).status).toBe(401);
  });

  it("lists each tenant's key, ATS and status with times as ISO text", async () => {
    const res = await get();
    expect([res.status, JSON.parse(res.body)]).toEqual([
      200,
      {
        items: [
          {
            tenantKey: "workday:globex",
            ats: "workday",
            status: "active",
            createdAt: "2026-11-25T12:00:00.000Z",
            changedAt: "2026-11-25T12:00:00.000Z",
          },
          {
            tenantKey: "workday:initech",
            ats: "workday",
            status: "none",
            createdAt: "2026-11-25T12:00:00.000Z",
            changedAt: null,
          },
        ],
      },
    ]);
  });

  it("never returns an email or URL, even if the read hands it one", async () => {
    list = async () =>
      TENANTS.map((t) => ({
        ...t,
        accountEmail: "applicant@example.com",
        tenantUrl: "https://globex.example.com",
      }));
    expect((await get()).body).not.toMatch(/example\.com/);
  });

  it("answers 503 when the registry can't be read", async () => {
    list = async () => {
      throw new Error("database down");
    };
    const res = await get();
    expect([res.status, JSON.parse(res.body)]).toEqual([503, { error: "unavailable" }]);
  });
});
