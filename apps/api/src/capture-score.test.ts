import { createServer, type Server } from "node:http";
import type { IngestResult } from "@northstar/sources";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type CapturePorts, captureEndpoint } from "./capture.js";
import type { ApiConfig } from "./config.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";
import { portOf, type Sent, send } from "./test/http.js";

// POST /jobs/capture scoring the saved job straight away (NS-186), with the ingest paths and the
// scoring pass faked. Synthetic data only: made-up keys, an invented company, example.com links.
const SIGNIN = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")
const EXT_TOKEN = "test-extension-token";
const EXT_HASH = "2f50a0607c1fb6606c98272169b134502f7c188b1e17f3d1579320aa3e3fb6c4"; // sha256(EXT_TOKEN)
const WEB = "http://northstar.localhost:3100";
const EXT_ORIGIN = `chrome-extension://${"a".repeat(32)}`;
const OWN_SITE = "https://jobs.example.com/postings/123";
// A posting on a known ATS: read through the ATS's own API (the link path).
const ATS_LINK = "https://boards.greenhouse.io/globex/jobs/123";

const exporter = new InMemorySpanExporter();
beforeAll(() => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});
afterAll(() => {
  trace.disable();
});
beforeEach(() => {
  exporter.reset();
});

const saved = (status: "created" | "merged" | "unchanged"): IngestResult => ({
  status,
  jobId: "job-1",
  method: "text",
  found: ["title", "company"],
  missing: [],
  dropped: [],
  record: null,
});

let server: Server | undefined;
afterEach(async () => {
  const s = server;
  server = undefined;
  if (s) await new Promise<void>((done) => s.close(() => done()));
});

// A server whose capture answers `result` and whose scoring pass does `score`. `calls` records
// the order of saves and scoring passes.
async function serve(result: IngestResult, score?: () => Promise<unknown>) {
  const calls: string[] = [];
  const ports: CapturePorts = {
    byUrl: async () => {
      calls.push("save by link");
      return result;
    },
    byText: async () => {
      calls.push("save");
      return result;
    },
  };
  if (score) {
    ports.score = async () => {
      calls.push("score");
      return score();
    };
  }
  const s = createServer();
  server = s;
  await new Promise<void>((done) => s.listen(0, "127.0.0.1", done));
  const config: ApiConfig = { signinKeySha256: SIGNIN, port: portOf(s), webOrigin: WEB };
  s.on(
    "request",
    createApi({
      config,
      sessions: createSessions(() => 0),
      extensionTokenSha256: EXT_HASH,
      extra: [captureEndpoint(ports)],
    }),
  );
  const capture = (url = OWN_SITE): Promise<Sent> =>
    send(s, {
      method: "POST",
      path: "/jobs/capture",
      headers: {
        "content-type": "application/json",
        origin: EXT_ORIGIN,
        authorization: `Bearer ${EXT_TOKEN}`,
      },
      body: JSON.stringify({
        url,
        title: "Engineer at Globex",
        text: "Globex is hiring.",
      }),
    });
  return { calls, capture };
}

const done = async () => ({ status: "done" });

describe("POST /jobs/capture: scoring the saved job", () => {
  for (const status of ["created", "merged", "unchanged"] as const) {
    it(`runs one scoring pass after the save when the capture ends ${status}`, async () => {
      const { calls, capture } = await serve(saved(status), done);
      const res = await capture();
      expect(res.status).toBe(200);
      expect(calls).toEqual(["save", "score"]);
    });
  }

  it("scores after a job saved through an ATS link, too", async () => {
    const { calls, capture } = await serve(saved("created"), done);
    const res = await capture(ATS_LINK);
    expect(JSON.parse(res.body)).toMatchObject({ status: "created", via: "link" });
    expect(calls).toEqual(["save by link", "score"]);
  });

  it("names a failed scoring pass on the request span, never its message", async () => {
    const { capture } = await serve(saved("created"), async () => {
      const e = new Error("relation fit_score does not exist");
      e.name = "DbError";
      throw e;
    });
    await capture();
    const span = exporter.getFinishedSpans().find((s) => s.name === "api.request");
    expect(span?.attributes["capture.score_error"]).toBe("DbError");
    expect(JSON.stringify(span?.attributes)).not.toContain("fit_score");
  });

  it("doesn't score when nothing was saved", async () => {
    const outcomes: IngestResult[] = [
      { status: "refused", reason: "a site Northstar never reads" },
      { status: "not_a_job", record: null },
      { status: "failed", reason: "the page couldn't be read" },
    ];
    for (const result of outcomes) {
      const { calls, capture } = await serve(result, done);
      await capture();
      expect(calls).toEqual(["save"]);
      const s = server;
      server = undefined;
      if (s) await new Promise<void>((d) => s.close(() => d()));
    }
  });

  it("answers the capture exactly as before when the scoring pass throws", async () => {
    const quiet = await serve(saved("created"));
    const expected = await quiet.capture();
    const s = server;
    server = undefined;
    if (s) await new Promise<void>((d) => s.close(() => d()));

    const { calls, capture } = await serve(saved("created"), async () => {
      throw new Error("relation fit_score does not exist");
    });
    const res = await capture();
    expect(calls).toEqual(["save", "score"]);
    expect(res.status).toBe(200);
    expect(res.body).toBe(expected.body);
  });

  it("doesn't score without a score port, as before", async () => {
    const { calls, capture } = await serve(saved("created"));
    expect((await capture()).status).toBe(200);
    expect(calls).toEqual(["save"]);
  });
});
