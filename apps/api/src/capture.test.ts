import { createServer, type Server } from "node:http";
import type { IngestResult } from "@northstar/sources";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CapturePorts, captureEndpoint } from "./capture.js";
import type { ApiConfig } from "./config.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";
import { portOf, type Sent, send } from "./test/http.js";

// POST /jobs/capture over a real http server, with the ingest paths faked. Synthetic data only:
// made-up keys, an invented company, example.com links.
const SIGNIN = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")
const EXT_TOKEN = "test-extension-token";
const EXT_HASH = "2f50a0607c1fb6606c98272169b134502f7c188b1e17f3d1579320aa3e3fb6c4"; // sha256(EXT_TOKEN)
const WEB = "http://northstar.localhost:3100";
const EXT_ORIGIN = `chrome-extension://${"a".repeat(32)}`;
// A posting on a known ATS: its link is read through the ATS's own API.
const URL_LINK = "https://boards.greenhouse.io/globex/jobs/123";
// A posting on the company's own site: saved from the page text, never fetched by the server.
const OWN_SITE = "https://jobs.example.com/postings/123";
const LINKEDIN = "https://www.linkedin.com/jobs/view/123";

const created = (jobId: string, method: "ats_api" | "text"): IngestResult => ({
  status: "created",
  jobId,
  method,
  found: ["title", "company"],
  missing: ["salary"],
  dropped: [],
  record: null,
});

let server: Server;
let sessions: ReturnType<typeof createSessions>;
let calls: string[];
let byUrl: (url: string) => Promise<IngestResult>;
let byText: (url: string, text: string) => Promise<IngestResult>;

beforeEach(async () => {
  calls = [];
  byUrl = async () => created("job-1", "ats_api");
  byText = async () => created("job-2", "text");
  const ports: CapturePorts = {
    byUrl: (url) => {
      calls.push(`url ${url}`);
      return byUrl(url);
    },
    byText: (url, text) => {
      calls.push(`text ${url} ${text.length}`);
      return byText(url, text);
    },
  };
  server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const config: ApiConfig = { signinKeySha256: SIGNIN, port: portOf(server), webOrigin: WEB };
  sessions = createSessions(() => 0);
  server.on(
    "request",
    createApi({
      config,
      sessions,
      extensionTokenSha256: EXT_HASH,
      extra: [captureEndpoint(ports)],
    }),
  );
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const capture = (body: unknown, headers: Record<string, string> = {}): Promise<Sent> =>
  send(server, {
    method: "POST",
    path: "/jobs/capture",
    headers: {
      "content-type": "application/json",
      origin: EXT_ORIGIN,
      authorization: `Bearer ${EXT_TOKEN}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });

const page = { url: URL_LINK, title: "Engineer at Globex", text: "Globex is hiring an engineer." };

describe("POST /jobs/capture: who may call it", () => {
  it("refuses a request without a token with 401", async () => {
    const res = await capture(page, { authorization: "" });
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("refuses a wrong token with 401", async () => {
    const res = await capture(page, { authorization: "Bearer wrong-token" });
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("refuses a web-page Origin with 403, even with the right token", async () => {
    const res = await capture(page, { origin: WEB });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("refuses everyone when no extension token is configured", async () => {
    await new Promise<void>((done) => server.close(() => done()));
    server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const config: ApiConfig = { signinKeySha256: SIGNIN, port: portOf(server), webOrigin: WEB };
    const ports: CapturePorts = { byUrl, byText };
    server.on(
      "request",
      createApi({
        config,
        sessions: createSessions(() => 0),
        extensionTokenSha256: null,
        extra: [captureEndpoint(ports)],
      }),
    );
    expect((await capture(page)).status).toBe(401);
  });

  it("after five wrong tokens in a minute, even the right token gets 429", async () => {
    for (let i = 0; i < 5; i++) await capture(page, { authorization: "Bearer wrong-token" });
    const res = await capture(page);
    expect(res.status).toBe(429);
    expect(calls).toEqual([]);
  });

  it("a live session cookie doesn't open it without the token", async () => {
    const cookie = `ns_session=${sessions.open().token}`;
    const res = await capture(page, { authorization: "", cookie });
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("refuses a body over 96 KB with 413", async () => {
    const res = await capture({ ...page, text: "x".repeat(100 * 1024) });
    expect(res.status).toBe(413);
    expect(calls).toEqual([]);
  });

  it("the extension token doesn't open a session endpoint", async () => {
    const res = await send(server, {
      method: "GET",
      path: "/me",
      headers: { authorization: `Bearer ${EXT_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it("accepts a page up to 96 KB, which session endpoints would refuse", async () => {
    const res = await capture({ ...page, text: "x".repeat(20_000) });
    expect(res.status).toBe(200);
  });
});

describe("POST /jobs/capture: what it stores", () => {
  it("reads a known ATS's link first and answers with field names only", async () => {
    const res = await capture(page);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      status: "created",
      via: "link",
      jobId: "job-1",
      found: ["title", "company"],
      missing: ["salary"],
      reason: null,
    });
    expect(calls).toEqual([`url ${URL_LINK}`]);
  });

  it("saves a page off any known ATS from its text, without the server fetching it", async () => {
    // The page's owner controls its DNS, so the server never fetches it (DNS rebinding).
    const res = await capture({ ...page, url: OWN_SITE });
    expect(JSON.parse(res.body)).toMatchObject({ status: "created", via: "text", jobId: "job-2" });
    // The title leads the text, so the model sees it with the description.
    const text = `${page.title}\n\n${page.text}`;
    expect(calls).toEqual([`text ${OWN_SITE} ${text.length}`]);
  });

  it("saves a LinkedIn posting from its text and never reads the link", async () => {
    const res = await capture({ ...page, url: LINKEDIN });
    expect(JSON.parse(res.body)).toMatchObject({ status: "created", via: "text" });
    expect(calls.map((c) => c.split(" ")[0])).toEqual(["text"]);
  });

  it("falls back to the page text when the ATS refused the link", async () => {
    byUrl = async () => ({ status: "refused", reason: "not a valid link" });
    const res = await capture(page);
    expect(JSON.parse(res.body)).toMatchObject({ status: "created", via: "text" });
  });

  it("falls back to the page text when the link read failed", async () => {
    byUrl = async () => ({ status: "failed", reason: "the page answered 403" });
    const res = await capture(page);
    expect(JSON.parse(res.body)).toMatchObject({ status: "created", via: "text" });
  });

  it("falls back to the page text when the fetched page held no posting (a sign-in page)", async () => {
    byUrl = async () => ({ status: "not_a_job", record: null });
    const res = await capture(page);
    expect(JSON.parse(res.body)).toMatchObject({ status: "created", via: "text" });
  });

  it("says a known posting is already stored, without reading the text", async () => {
    byUrl = async () => ({
      status: "unchanged",
      jobId: "job-9",
      method: null,
      found: [],
      missing: [],
      dropped: [],
      record: null,
    });
    const res = await capture(page);
    expect(JSON.parse(res.body)).toEqual({
      status: "unchanged",
      via: "link",
      jobId: "job-9",
      found: [],
      missing: [],
      reason: null,
    });
    expect(calls).toEqual([`url ${URL_LINK}`]);
  });

  it("passes a refusal from the text path back with its reason", async () => {
    byText = async () => ({ status: "refused", reason: "--url must be an http(s) link" });
    const res = await capture({ ...page, url: "ftp://example.com/x" });
    expect(calls.map((c) => c.split(" ")[0])).toEqual(["text"]);
    expect(JSON.parse(res.body)).toEqual({
      status: "refused",
      via: "text",
      jobId: null,
      found: [],
      missing: [],
      reason: "--url must be an http(s) link",
    });
  });

  it("refuses an empty page text with 400 before reading anything", async () => {
    const res = await capture({ ...page, text: "" });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_input", paths: ["text"] });
    expect(calls).toEqual([]);
  });

  it("refuses whitespace-only page text with 400", async () => {
    const res = await capture({ ...page, text: "   \n  " });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("refuses a capture without a URL with 400, naming the field", async () => {
    const res = await capture({ title: page.title, text: page.text });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_input", paths: ["url"] });
  });

  it("refuses page text over 20,000 characters with 400", async () => {
    const res = await capture({ ...page, text: "x".repeat(20_001) });
    expect(res.status).toBe(400);
  });
});
