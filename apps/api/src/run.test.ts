import { createServer, type Server } from "node:http";
import type { RunView } from "@northstar/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "./config.js";
import { type RunPorts, runEndpoints } from "./run.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";
import { portOf, type Sent, send } from "./test/http.js";

// The run inspector endpoint (NS-154) over a real http server, with the database faked.
// Synthetic steps only.
const HASH = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")
const WEB = "http://northstar.localhost:3100";
const T = new Date("2026-11-26T09:00:00Z");

const CALL = {
  route: "job-extract",
  promptId: "job-extract",
  promptVersion: 2,
  modelRequested: "claude-opus-5-5",
  modelServed: "claude-opus-5-5",
  effort: "medium",
  inputTokens: 1200,
  outputTokens: 300,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  latencyMs: 2100,
  costUsd: 0.0123,
  stopReason: "end_turn",
  refusalCategory: null,
  fallbackUsed: false,
};

const RUN: RunView = {
  steps: [
    {
      position: 7n,
      occurredAt: T,
      type: "job.added",
      actor: "system",
      line: "Added a job.",
      offsetMs: 0,
      call: CALL,
    },
  ],
  totals: {
    steps: 1,
    calls: 1,
    inputTokens: 1200,
    outputTokens: 300,
    costUsd: 0.0123,
    unpricedCalls: 0,
    durationMs: 0,
  },
  truncated: false,
};

let server: Server;
let cookie: string;
let asked: bigint[];
let ports: RunPorts;

beforeEach(async () => {
  asked = [];
  ports = {
    readRun: async (position) => {
      asked.push(position);
      return position === 7n ? RUN : null;
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
      extra: runEndpoints({ readRun: (p) => ports.readRun(p) }),
    }),
  );
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const get = (query: string, withCookie = true): Promise<Sent> =>
  send(server, { method: "GET", path: `/feed/run${query}`, headers: withCookie ? { cookie } : {} });

describe("GET /feed/run", () => {
  it("refuses a request without a session with 401, and reads nothing", async () => {
    expect([(await get("?position=7", false)).status, asked]).toEqual([401, []]);
  });

  it("returns the run's steps, calls and totals", async () => {
    const res = await get("?position=7");
    expect([res.status, JSON.parse(res.body)]).toEqual([
      200,
      {
        steps: [
          {
            position: "7",
            occurredAt: "2026-11-26T09:00:00.000Z",
            type: "job.added",
            actor: "system",
            line: "Added a job.",
            offsetMs: 0,
            call: CALL,
          },
        ],
        totals: RUN.totals,
        truncated: false,
      },
    ]);
  });

  it("never passes on a call field the read didn't promise", async () => {
    ports.readRun = async () => ({
      ...RUN,
      steps: RUN.steps.map((s) => ({
        ...s,
        call: { ...CALL, prompt: "secret prompt text" } as typeof CALL,
      })),
    });
    expect((await get("?position=7")).body).not.toContain("secret prompt");
  });

  it("answers 404 for a position with no run", async () => {
    expect((await get("?position=8")).status).toBe(404);
  });

  it("refuses a position that isn't one with 400, before reading anything", async () => {
    expect([
      (await get("?position=-1")).status,
      (await get("?position=abc")).status,
      (await get("?position=99999999999999999999")).status,
      (await get("")).status,
      asked,
    ]).toEqual([400, 400, 400, 400, []]);
  });

  it("answers 503 when the run can't be read", async () => {
    ports.readRun = async () => {
      throw new Error("database down");
    };
    const res = await get("?position=7");
    expect([res.status, JSON.parse(res.body)]).toEqual([503, { error: "unavailable" }]);
  });
});
