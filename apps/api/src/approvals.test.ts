import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ApprovalPorts, approvalEndpoints, MAX_BATCH } from "./approvals.js";
import type { ApiConfig } from "./config.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";
import { portOf, type Sent, send } from "./test/http.js";

// The approval queue endpoints (NS-139) over a real http server, with the Gate faked. Synthetic
// ids only.
const HASH = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")
const EXT_HASH = "a".repeat(64);
const WEB = "http://northstar.localhost:3100";
const T = new Date("2026-11-25T12:00:00Z");
const LATER = new Date("2026-11-25T12:02:00Z");
const R1 = "0b6f3f8e-6a55-4c7e-9a52-5d6b2f8a1c01";
const R2 = "7a2c9e41-1d3b-4f6a-8e5c-2b9d0f1a3c55";
const D1 = "5c1e2a7d-3b4f-4e8a-9c6d-7f0a1b2c3d4e";

let server: Server;
let cookie: string;
let calls: unknown[];
let ports: ApprovalPorts;

beforeEach(async () => {
  calls = [];
  ports = {
    list: async (kind) => {
      calls.push(["list", kind]);
      return [
        {
          requestId: R1,
          kind: "application_package",
          subject: `application_package:${R1}`,
          requestedAt: T,
        },
      ];
    },
    decide: async (input) => {
      calls.push(["decide", input]);
      if (input.decision === "reject" && !input.reason?.trim()) {
        return { ok: false, error: { kind: "ReasonRequired" } };
      }
      return {
        ok: true,
        value: input.requestIds.map((requestId) =>
          requestId === R1
            ? {
                requestId,
                result: {
                  ok: true,
                  value: {
                    decisionId: D1,
                    requestId,
                    decision: input.decision === "approve" ? "approved" : "rejected",
                    decidedBy: "user",
                    ruleName: null,
                    decidedAt: T,
                    effectiveAt: LATER,
                  },
                },
              }
            : { requestId, result: { ok: false, error: { kind: "AlreadyDecided" } } },
        ),
      };
    },
    undo: async (decisionId) => {
      calls.push(["undo", decisionId]);
      if (decisionId === D1) return { ok: true, value: { requestId: R1 } };
      return { ok: false, error: { kind: "UndoWindowClosed" } };
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
      extra: approvalEndpoints({
        list: (k) => ports.list(k),
        decide: (i) => ports.decide(i),
        undo: (d) => ports.undo(d),
      }),
    }),
  );
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const get = (path: string, headers: Record<string, string> = { cookie }): Promise<Sent> =>
  send(server, { method: "GET", path, headers });

const post = (path: string, body: unknown, withCookie = true): Promise<Sent> =>
  send(server, {
    method: "POST",
    path,
    headers: {
      "content-type": "application/json",
      origin: WEB,
      ...(withCookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });

describe("who may call them", () => {
  it("each endpoint refuses a request without a session with 401 and reaches nothing", async () => {
    expect((await get("/approvals", {})).status).toBe(401);
    expect(
      (await post("/approvals/decide", { requestIds: [R1], decision: "approve" }, false)).status,
    ).toBe(401);
    expect((await post("/approvals/undo", { decisionId: D1 }, false)).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("the extension token can't open the queue, decide or undo", async () => {
    const bearer = { authorization: "Bearer test-extension-token" };
    const viaToken = (path: string, body: unknown) =>
      send(server, {
        method: "POST",
        path,
        headers: { "content-type": "application/json", origin: WEB, ...bearer },
        body: JSON.stringify(body),
      });
    expect([
      (await get("/approvals", bearer)).status,
      (await viaToken("/approvals/decide", { requestIds: [R1], decision: "approve" })).status,
      (await viaToken("/approvals/undo", { decisionId: D1 })).status,
    ]).toEqual([401, 401, 401]);
    expect(calls).toEqual([]);
  });
});

describe("GET /approvals", () => {
  it("lists the pending queue with times as ISO text", async () => {
    const res = await get("/approvals");
    expect([res.status, JSON.parse(res.body)]).toEqual([
      200,
      {
        items: [
          {
            requestId: R1,
            kind: "application_package",
            subject: `application_package:${R1}`,
            requestedAt: "2026-11-25T12:00:00.000Z",
          },
        ],
      },
    ]);
    expect(calls).toEqual([["list", undefined]]);
  });

  it("filters by kind, and refuses a kind the Gate doesn't know", async () => {
    await get("/approvals?kind=answer");
    expect(calls).toEqual([["list", "answer"]]);
    expect((await get("/approvals?kind=anything")).status).toBe(400);
  });

  it("answers 503 when the queue can't be read", async () => {
    ports.list = async () => {
      throw new Error("database down");
    };
    const res = await get("/approvals");
    expect([res.status, JSON.parse(res.body)]).toEqual([503, { error: "unavailable" }]);
  });
});

describe("POST /approvals/decide", () => {
  it("approves a batch and reports each id's outcome", async () => {
    const res = await post("/approvals/decide", { requestIds: [R1, R2], decision: "approve" });
    expect([res.status, JSON.parse(res.body)]).toEqual([
      200,
      {
        outcomes: [
          {
            requestId: R1,
            outcome: "approved",
            decisionId: D1,
            effectiveAt: "2026-11-25T12:02:00.000Z",
          },
          { requestId: R2, outcome: "already_decided" },
        ],
      },
    ]);
    expect(calls).toEqual([["decide", { requestIds: [R1, R2], decision: "approve" }]]);
  });

  it("passes Paul's reject reason through", async () => {
    await post("/approvals/decide", { requestIds: [R1], decision: "reject", reason: "Wrong team" });
    expect(calls).toEqual([
      ["decide", { requestIds: [R1], decision: "reject", reason: "Wrong team" }],
    ]);
  });

  it("refuses a rejection without a reason with 400", async () => {
    const res = await post("/approvals/decide", { requestIds: [R1], decision: "reject" });
    expect([res.status, JSON.parse(res.body)]).toEqual([400, { error: "reason_required" }]);
  });

  it(`refuses more than ${MAX_BATCH} ids, or none, with 400 before reaching the Gate`, async () => {
    const many = Array.from({ length: MAX_BATCH + 1 }, () => R1);
    expect(
      (await post("/approvals/decide", { requestIds: many, decision: "approve" })).status,
    ).toBe(400);
    expect((await post("/approvals/decide", { requestIds: [], decision: "approve" })).status).toBe(
      400,
    );
    expect(calls).toEqual([]);
  });

  it("ignores a decider named in the body: the Gate records Paul", async () => {
    await post("/approvals/decide", { requestIds: [R1], decision: "approve", decidedBy: "policy" });
    expect(calls).toEqual([["decide", { requestIds: [R1], decision: "approve" }]]);
  });
});

describe("POST /approvals/undo", () => {
  it("undoes a decision inside its window", async () => {
    const res = await post("/approvals/undo", { decisionId: D1 });
    expect([res.status, JSON.parse(res.body)]).toEqual([200, { requestId: R1 }]);
  });

  it("answers 409 with the reason when the window has closed", async () => {
    const res = await post("/approvals/undo", { decisionId: R2 });
    expect([res.status, JSON.parse(res.body)]).toEqual([409, { error: "undo_window_closed" }]);
  });

  it("maps each refusal to its status and code", async () => {
    const answers = [];
    for (const kind of [
      "NotFound",
      "AlreadyUndone",
      "UndoWindowClosed",
      "SubjectReopened",
    ] as const) {
      ports.undo = async () => ({ ok: false, error: { kind } });
      const res = await post("/approvals/undo", { decisionId: D1 });
      answers.push([res.status, JSON.parse(res.body).error]);
    }
    expect(answers).toEqual([
      [404, "not_found"],
      [409, "already_undone"],
      [409, "undo_window_closed"],
      [409, "subject_reopened"],
    ]);
  });
});
