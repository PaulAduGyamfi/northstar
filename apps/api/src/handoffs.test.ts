import { createServer, type Server } from "node:http";
import type { HandoffOutcome, HandoffView } from "@northstar/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "./config.js";
import { type HandoffPorts, handoffEndpoints, handoffSubmittedKey } from "./handoffs.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";
import { portOf, type Sent, send } from "./test/http.js";

// The "Needs your hands" endpoints over a real http server, with the database faked the way
// packages/db behaves: an outcome is stored once, and a move under a used key replays.
// Synthetic ids and example links only.
const HASH = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")
const WEB = "http://northstar.localhost:3100";
const T = new Date("2026-11-25T12:00:00Z");
const HANDOFF = "0b6f3f8e-6a55-4c7e-9a52-5d6b2f8a1c01";
const APPLICATION = "5c1e2a7d-3b4f-4e8a-9c6d-7f0a1b2c3d4e";

const OPEN: HandoffView = {
  handoffId: HANDOFF,
  submissionId: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",
  applicationId: APPLICATION,
  ats: "greenhouse",
  reason: "captcha",
  applyUrl: "https://boards.greenhouse.io/example/jobs/123",
  createdAt: T,
};

let server: Server;
let cookie: string;
let stored: Map<string, HandoffOutcome>;
let moves: string[];
let movedKeys: Set<string>;
let moveFails: boolean;
let open: HandoffView[];
let leftNeedsHuman: boolean;

beforeEach(async () => {
  stored = new Map();
  moves = [];
  movedKeys = new Set();
  moveFails = false;
  open = [OPEN];
  leftNeedsHuman = false;
  const ports: HandoffPorts = {
    listOpen: async () => open,
    resolve: async (handoffId, outcome) => {
      if (handoffId !== HANDOFF) return { ok: false, error: { kind: "NotFound" } };
      if (leftNeedsHuman && outcome === "submitted" && !stored.has(handoffId)) {
        return { ok: false, error: { kind: "NotNeedsHuman" } };
      }
      const before = stored.get(handoffId);
      if (before) {
        return {
          ok: true,
          value: { applicationId: APPLICATION, outcome: before, replayed: true },
        };
      }
      stored.set(handoffId, outcome);
      return { ok: true, value: { applicationId: APPLICATION, outcome, replayed: false } };
    },
    markSubmitted: async (applicationId, key) => {
      if (moveFails) return { ok: false };
      // A used key replays: the application moves once however often it is called.
      if (!movedKeys.has(key)) moves.push(applicationId);
      movedKeys.add(key);
      return { ok: true };
    },
  };
  const sessions = createSessions(() => 0);
  cookie = `ns_session=${sessions.open().token}`;
  server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const config: ApiConfig = { signinKeySha256: HASH, port: portOf(server), webOrigin: WEB };
  server.on("request", createApi({ config, sessions, extra: handoffEndpoints(ports) }));
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const list = (withCookie = true): Promise<Sent> =>
  send(server, { method: "GET", path: "/handoffs", headers: withCookie ? { cookie } : {} });

const resolve = (body: unknown, withCookie = true): Promise<Sent> =>
  send(server, {
    method: "POST",
    path: "/handoffs/resolve",
    headers: {
      "content-type": "application/json",
      origin: WEB,
      ...(withCookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });

describe("who may call them", () => {
  it("each endpoint refuses a request without a session with 401 and touches nothing", async () => {
    expect((await list(false)).status).toBe(401);
    expect((await resolve({ handoffId: HANDOFF, outcome: "submitted" }, false)).status).toBe(401);
    expect([stored.size, moves]).toEqual([0, []]);
  });
});

describe("GET /handoffs", () => {
  it("lists the open handoffs with their https link and time as ISO text", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      items: [
        {
          handoffId: HANDOFF,
          applicationId: APPLICATION,
          ats: "greenhouse",
          reason: "captcha",
          applyUrl: "https://boards.greenhouse.io/example/jobs/123",
          createdAt: "2026-11-25T12:00:00.000Z",
        },
      ],
    });
  });

  it("never hands out a link that isn't https", async () => {
    open = [{ ...OPEN, applyUrl: "javascript:alert(1)" }];
    expect((await list()).status).toBe(500);
  });
});

describe("POST /handoffs/resolve", () => {
  it("'I submitted it' moves the application once under the handoff's key", async () => {
    const res = await resolve({ handoffId: HANDOFF, outcome: "submitted" });
    expect([res.status, JSON.parse(res.body)]).toEqual([
      200,
      { outcome: "submitted", replayed: false },
    ]);
    expect([...movedKeys]).toEqual([handoffSubmittedKey(APPLICATION, HANDOFF)]);
    expect(moves).toEqual([APPLICATION]);
  });

  it("sending 'I submitted it' twice moves the application once", async () => {
    await resolve({ handoffId: HANDOFF, outcome: "submitted" });
    const again = await resolve({ handoffId: HANDOFF, outcome: "submitted" });
    expect(JSON.parse(again.body)).toEqual({ outcome: "submitted", replayed: true });
    expect(moves).toEqual([APPLICATION]);
  });

  it("'I gave up' stores the outcome and moves nothing", async () => {
    const res = await resolve({ handoffId: HANDOFF, outcome: "gave_up" });
    expect(JSON.parse(res.body)).toEqual({ outcome: "gave_up", replayed: false });
    expect(moves).toEqual([]);
  });

  it("a later 'I submitted it' can't overturn 'I gave up'", async () => {
    await resolve({ handoffId: HANDOFF, outcome: "gave_up" });
    const res = await resolve({ handoffId: HANDOFF, outcome: "submitted" });
    expect(JSON.parse(res.body)).toEqual({ outcome: "gave_up", replayed: true });
    expect(moves).toEqual([]);
  });

  it("answers 500 when the move fails, and a resend finishes it", async () => {
    moveFails = true;
    expect((await resolve({ handoffId: HANDOFF, outcome: "submitted" })).status).toBe(500);
    moveFails = false;
    expect((await resolve({ handoffId: HANDOFF, outcome: "submitted" })).status).toBe(200);
    expect(moves).toEqual([APPLICATION]);
  });

  it("answers 409 to 'I submitted it' once the application left needs_human, moving nothing", async () => {
    leftNeedsHuman = true;
    const res = await resolve({ handoffId: HANDOFF, outcome: "submitted" });
    expect([res.status, JSON.parse(res.body)]).toEqual([409, { error: "not_needs_human" }]);
    expect(moves).toEqual([]);
  });

  it("answers 404 for an unknown handoff", async () => {
    const res = await resolve({
      handoffId: "00000000-0000-4000-8000-000000000000",
      outcome: "gave_up",
    });
    expect([res.status, JSON.parse(res.body)]).toEqual([404, { error: "not_found" }]);
  });

  it("refuses an outcome it doesn't know, or a handoff id that isn't a uuid, with 400", async () => {
    expect((await resolve({ handoffId: HANDOFF, outcome: "withdrawn" })).status).toBe(400);
    expect((await resolve({ handoffId: "1 or 1=1", outcome: "gave_up" })).status).toBe(400);
    expect(stored.size).toBe(0);
  });
});
