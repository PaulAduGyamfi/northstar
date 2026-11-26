import { createServer, type Server } from "node:http";
import type { Inbox } from "@northstar/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "./config.js";
import { inboxEndpoints } from "./inbox.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";
import { portOf, type Sent, send } from "./test/http.js";

// GET /inbox (NS-165) over a real http server, with the database faked. Synthetic threads only.
const HASH = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")
const WEB = "http://northstar.localhost:3100";
const T = new Date("2026-11-25T12:00:00Z");
const A1 = "0b6f3f8e-6a55-4c7e-9a52-5d6b2f8a1c01";

const INBOX: Inbox = {
  applications: [
    {
      applicationId: A1,
      jobTitle: "Backend Engineer",
      company: "Example Corp",
      status: "submitted",
      origin: { startedBy: "northstar", submittedVia: "approved" },
      threads: [
        {
          gmailThreadId: "aa01",
          messages: 2,
          lastReceivedAt: T,
          step: "tag",
          senderVerified: false,
          kind: null,
        },
        // Never stored (the CHECK refuses it), but the endpoint must not trust that.
        {
          gmailThreadId: "x/../evil",
          messages: 1,
          lastReceivedAt: T,
          step: "tag",
          senderVerified: false,
          kind: null,
        },
      ],
    },
  ],
  queued: [{ gmailThreadId: "cc01", messages: 1, lastReceivedAt: T, reason: "no_match" }],
};

let server: Server;
let cookie: string;
let reads: number;
let read: () => Promise<Inbox>;

beforeEach(async () => {
  reads = 0;
  read = async () => INBOX;
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
      extensionTokenSha256: null,
      extra: inboxEndpoints({
        read: () => {
          reads += 1;
          return read();
        },
      }),
    }),
  );
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const get = (withCookie = true): Promise<Sent> =>
  send(server, { method: "GET", path: "/inbox", headers: withCookie ? { cookie } : {} });

describe("GET /inbox", () => {
  it("refuses a request without a session with 401 and reads nothing", async () => {
    expect((await get(false)).status).toBe(401);
    expect(reads).toBe(0);
  });

  it("returns threads by application with origin, a Gmail link and ISO times", async () => {
    const res = await get();
    expect([res.status, JSON.parse(res.body)]).toEqual([
      200,
      {
        applications: [
          {
            applicationId: A1,
            jobTitle: "Backend Engineer",
            company: "Example Corp",
            status: "submitted",
            startedBy: "northstar",
            submittedVia: "approved",
            threads: [
              {
                gmailThreadId: "aa01",
                gmailUrl: "https://mail.google.com/mail/u/0/#all/aa01",
                messages: 2,
                lastReceivedAt: "2026-11-25T12:00:00.000Z",
                step: "tag",
                senderVerified: false,
                kind: null,
              },
            ],
          },
        ],
        queued: [
          {
            gmailThreadId: "cc01",
            gmailUrl: "https://mail.google.com/mail/u/0/#all/cc01",
            messages: 1,
            lastReceivedAt: "2026-11-25T12:00:00.000Z",
            reason: "no_match",
          },
        ],
      },
    ]);
  });

  it("answers 503 when the inbox can't be read", async () => {
    read = async () => {
      throw new Error("connection refused");
    };
    const res = await get();
    expect([res.status, JSON.parse(res.body)]).toEqual([503, { error: "unavailable" }]);
  });

  it("passes a thread's recruiter grade on field by field, and leaves it off ungraded threads", async () => {
    const grade = { grade: "B", reasons: ["title:exact", "pay:unknown"], confidence: "low" };
    read = async () => ({
      applications: [
        {
          ...(INBOX.applications[0] as Inbox["applications"][number]),
          threads: [
            {
              gmailThreadId: "aa01",
              messages: 1,
              lastReceivedAt: T,
              step: "tag",
              senderVerified: true,
              kind: null,
              recruiterGrade: { ...grade, extra: "never shown" } as typeof grade,
            },
          ],
        },
      ],
      queued: [
        {
          gmailThreadId: "cc01",
          messages: 1,
          lastReceivedAt: T,
          reason: "no_match",
          recruiterGrade: grade,
        },
        { gmailThreadId: "cc02", messages: 1, lastReceivedAt: T, reason: "no_match" },
      ],
    });
    const body = JSON.parse((await get()).body);
    expect([
      body.applications[0].threads[0].recruiterGrade,
      body.queued.map((q: { recruiterGrade?: unknown }) => q.recruiterGrade ?? null),
    ]).toEqual([grade, [grade, null]]);
  });

  it("answers 500 rather than pass on a grade reason that isn't a code", async () => {
    read = async () => ({
      applications: [],
      queued: [
        {
          gmailThreadId: "cc01",
          messages: 1,
          lastReceivedAt: T,
          reason: "no_match",
          recruiterGrade: { grade: "B", reasons: ["Hi Paul <b>call me</b>"], confidence: "normal" },
        },
      ],
    });
    expect((await get()).status).toBe(500);
  });
});
