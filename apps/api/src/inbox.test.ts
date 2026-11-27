import { createServer, type Server } from "node:http";
import type { Inbox, LinkTarget } from "@northstar/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "./config.js";
import { type InboxPorts, inboxEndpoints } from "./inbox.js";
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
let targets: () => Promise<LinkTarget[]>;
let decide: InboxPorts["decide"];
let decided: Parameters<InboxPorts["decide"]>[0][];
let regrade: NonNullable<InboxPorts["regrade"]>;
let regraded: { gmailThreadId: string; grade: string }[];

beforeEach(async () => {
  reads = 0;
  read = async () => INBOX;
  targets = async () => [{ applicationId: A1, jobTitle: "Backend Engineer", company: null }];
  decide = async () => ({ ok: true, value: { recorded: 2 } });
  decided = [];
  regrade = async () => ({ ok: true, value: { recorded: true } });
  regraded = [];
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
        targets: () => targets(),
        decide: (input) => {
          decided.push(input);
          return decide(input);
        },
        regrade: (input) => {
          regraded.push(input);
          return regrade(input);
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

const post = (body: unknown, withCookie = true): Promise<Sent> =>
  send(server, {
    method: "POST",
    path: "/inbox/decide",
    headers: {
      ...(withCookie ? { cookie } : {}),
      origin: WEB,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

describe("GET /inbox/link-targets (NS-262)", () => {
  it("lists the open applications field by field, behind the session", async () => {
    // A field the read might add later must never reach the response.
    const withExtra = {
      applicationId: A1,
      jobTitle: "Backend Engineer",
      company: null,
      extra: "x",
    };
    targets = async () => [withExtra];
    const signedOut = await send(server, { method: "GET", path: "/inbox/link-targets" });
    const res = await send(server, {
      method: "GET",
      path: "/inbox/link-targets",
      headers: { cookie },
    });
    expect([signedOut.status, res.status, JSON.parse(res.body)]).toEqual([
      401,
      200,
      { items: [{ applicationId: A1, jobTitle: "Backend Engineer", company: null }] },
    ]);
  });
});

describe("POST /inbox/decide (NS-262)", () => {
  it("links a queued thread to an application and answers how many messages it decided", async () => {
    const res = await post({ gmailThreadId: "cc01", decision: "link", applicationId: A1 });
    expect([res.status, JSON.parse(res.body), decided]).toEqual([
      200,
      { decision: "link", recorded: 2 },
      [{ gmailThreadId: "cc01", decision: { kind: "link", applicationId: A1 } }],
    ]);
  });

  it("dismisses a queued thread", async () => {
    const res = await post({ gmailThreadId: "cc01", decision: "dismiss" });
    expect([res.status, decided]).toEqual([
      200,
      [{ gmailThreadId: "cc01", decision: { kind: "dismiss" } }],
    ]);
  });

  it("refuses a request without a session, a link with no application and a bad thread id, deciding nothing", async () => {
    const results = [
      await post({ gmailThreadId: "cc01", decision: "dismiss" }, false),
      await post({ gmailThreadId: "cc01", decision: "link" }),
      await post({ gmailThreadId: "cc01", decision: "dismiss", applicationId: A1 }),
      await post({ gmailThreadId: "x/../evil", decision: "dismiss" }),
    ];
    expect([results.map((r) => r.status), decided]).toEqual([[401, 400, 400, 400], []]);
  });

  it("names each refusal of the write", async () => {
    const answers = [];
    for (const kind of ["NotFound", "UnknownApplication", "ApplicationClosed"] as const) {
      decide = async () => ({ ok: false, error: { kind } });
      const res = await post({ gmailThreadId: "cc01", decision: "link", applicationId: A1 });
      answers.push([res.status, JSON.parse(res.body)]);
    }
    decide = async () => {
      throw new Error("connection refused");
    };
    const down = await post({ gmailThreadId: "cc01", decision: "dismiss" });
    expect([...answers, [down.status, JSON.parse(down.body)]]).toEqual([
      [404, { error: "not_found" }],
      [404, { error: "unknown_application" }],
      [409, { error: "application_closed" }],
      [503, { error: "unavailable" }],
    ]);
  });
});

describe("POST /inbox/regrade (NS-238 item 3)", () => {
  const regradePost = (body: unknown, withCookie = true): Promise<Sent> =>
    send(server, {
      method: "POST",
      path: "/inbox/regrade",
      headers: {
        ...(withCookie ? { cookie } : {}),
        origin: WEB,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  it("records Paul's letter for a thread and answers whether it stored one", async () => {
    const res = await regradePost({ gmailThreadId: "cc01", grade: "D" });
    expect([res.status, JSON.parse(res.body), regraded]).toEqual([
      200,
      { grade: "D", recorded: true },
      [{ gmailThreadId: "cc01", grade: "D" }],
    ]);
  });

  it("refuses no session, a letter that isn't one and a bad thread id, regrading nothing", async () => {
    const results = [
      await regradePost({ gmailThreadId: "cc01", grade: "D" }, false),
      await regradePost({ gmailThreadId: "cc01", grade: "E" }),
      await regradePost({ gmailThreadId: "x/../evil", grade: "D" }),
    ];
    expect([results.map((r) => r.status), regraded]).toEqual([[401, 400, 400], []]);
  });

  it("answers 404 for a thread with no graded email and 503 when the store fails", async () => {
    regrade = async () => ({ ok: false, error: { kind: "NotGraded" } });
    const missing = await regradePost({ gmailThreadId: "cc01", grade: "D" });
    regrade = async () => {
      throw new Error("connection refused");
    };
    const down = await regradePost({ gmailThreadId: "cc01", grade: "D" });
    expect([
      [missing.status, JSON.parse(missing.body)],
      [down.status, JSON.parse(down.body)],
    ]).toEqual([
      [404, { error: "not_graded" }],
      [503, { error: "unavailable" }],
    ]);
  });

  it("passes Paul's letter on with a thread's grade", async () => {
    const grade = { grade: "B", reasons: ["title:exact"], confidence: "normal", paulGrade: "D" };
    read = async () => ({
      applications: [],
      queued: [
        {
          gmailThreadId: "cc01",
          messages: 1,
          lastReceivedAt: T,
          reason: "no_match",
          recruiterGrade: grade,
        },
      ],
    });
    const body = JSON.parse((await get()).body);
    expect(body.queued[0].recruiterGrade).toEqual(grade);
  });
});
