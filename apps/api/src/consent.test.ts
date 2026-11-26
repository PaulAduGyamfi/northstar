import { createServer, type Server } from "node:http";
import type { ConsentRecordView } from "@northstar/db";
import type { ConsentPolicy } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "./config.js";
import { type ConsentPorts, consentEndpoints } from "./consent.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";
import { portOf, type Sent, send } from "./test/http.js";

// The consent policy and accepted notices (NS-198) over a real http server, with the database
// faked. Synthetic tenants and made-up notice text only.
const HASH = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")
const WEB = "http://northstar.localhost:3100";
const T = new Date("2026-11-25T12:00:00Z");
const R1 = "0b6f3f8e-6a55-4c7e-9a52-5d6b2f8a1c01";
const TEXT = "Globex Candidate Privacy Notice. We keep your application for two years.";

const RECORDS: ConsentRecordView[] = [
  {
    recordId: R1,
    tenantKey: "workday:globex",
    kind: "privacy",
    noticeUrl: "https://globex.example.com/privacy",
    acceptedAt: T,
  },
];

let server: Server;
let cookie: string;
let calls: unknown[];
let ports: ConsentPorts;

beforeEach(async () => {
  calls = [];
  let policy: ConsentPolicy = "auto";
  ports = {
    readPolicy: async () => policy,
    setPolicy: async (p) => {
      calls.push(["set", p]);
      policy = p;
    },
    listConsents: async () => RECORDS,
    readConsentText: async (id) => (id === R1 ? TEXT : null),
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
      extra: consentEndpoints({
        readPolicy: () => ports.readPolicy(),
        setPolicy: (p) => ports.setPolicy(p),
        listConsents: () => ports.listConsents(),
        readConsentText: (id) => ports.readConsentText(id),
      }),
    }),
  );
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const get = (path: string, withCookie = true): Promise<Sent> =>
  send(server, { method: "GET", path, headers: withCookie ? { cookie } : {} });

const post = (body: unknown, withCookie = true): Promise<Sent> =>
  send(server, {
    method: "POST",
    path: "/settings/consent-policy",
    headers: { "content-type": "application/json", origin: WEB, ...(withCookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

describe("who may call them", () => {
  it("every endpoint refuses a request without a session with 401, and reaches nothing", async () => {
    expect([
      (await get("/settings/consent-policy", false)).status,
      (await post({ policy: "ask_per_tenant" }, false)).status,
      (await get("/accounts/consents", false)).status,
      (await get(`/accounts/consents/text?recordId=${R1}`, false)).status,
    ]).toEqual([401, 401, 401, 401]);
    expect(calls).toEqual([]);
  });
});

describe("the consent policy", () => {
  it("reads auto by default, saves Paul's choice and reads it back", async () => {
    const before = JSON.parse((await get("/settings/consent-policy")).body);
    const saved = await post({ policy: "ask_per_tenant" });
    const after = JSON.parse((await get("/settings/consent-policy")).body);
    expect([before, saved.status, JSON.parse(saved.body), after, calls]).toEqual([
      { policy: "auto" },
      200,
      { policy: "ask_per_tenant" },
      { policy: "ask_per_tenant" },
      [["set", "ask_per_tenant"]],
    ]);
  });

  it("refuses a policy that isn't one of the two with 400, and saves nothing", async () => {
    expect((await post({ policy: "accept_marketing" })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("answers 503 when the policy can't be saved", async () => {
    ports.setPolicy = async () => {
      throw new Error("database down");
    };
    const res = await post({ policy: "auto" });
    expect([res.status, JSON.parse(res.body)]).toEqual([503, { error: "unavailable" }]);
  });
});

describe("accepted notices", () => {
  it("lists each notice's tenant, kind, link and time, without its text", async () => {
    const res = await get("/accounts/consents");
    expect([res.status, JSON.parse(res.body)]).toEqual([
      200,
      {
        items: [
          {
            recordId: R1,
            tenantKey: "workday:globex",
            kind: "privacy",
            noticeUrl: "https://globex.example.com/privacy",
            acceptedAt: "2026-11-25T12:00:00.000Z",
          },
        ],
      },
    ]);
    expect(res.body).not.toContain("Candidate Privacy Notice");
  });

  it("never passes on a field the read didn't promise, such as the text or an email", async () => {
    ports.listConsents = async () =>
      RECORDS.map((r) => ({ ...r, text: TEXT, accountEmail: "applicant@example.com" }));
    const body = (await get("/accounts/consents")).body;
    expect(body).not.toMatch(/Candidate Privacy Notice|applicant@/);
  });

  it("gives one notice's text on request, and 404 for one Paul doesn't have", async () => {
    const found = await get(`/accounts/consents/text?recordId=${R1}`);
    const missing = await get(
      "/accounts/consents/text?recordId=7a2c9e41-1d3b-4f6a-8e5c-2b9d0f1a3c55",
    );
    expect([found.status, JSON.parse(found.body), missing.status]).toEqual([
      200,
      { text: TEXT },
      404,
    ]);
  });
});
