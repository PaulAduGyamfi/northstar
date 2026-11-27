import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "./config.js";
import { JOBS_PAGE_MAX, type JobsPorts, jobsEndpoints, postingLink } from "./jobs.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";
import { portOf, type Sent, send } from "./test/http.js";

// The jobs page's endpoint (NS-130 slice 10) over a real http server, with the readers faked.
// Invented companies, titles and ids only.
const HASH = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")
const EXT_HASH = "2f50a0607c1fb6606c98272169b134502f7c188b1e17f3d1579320aa3e3fb6c4";
const WEB = "http://northstar.localhost:3100";
const NOW = new Date("2026-11-27T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

type Row = Awaited<ReturnType<JobsPorts["jobs"]>>[number];
const job = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  status: "ready",
  title: "Backend Engineer",
  company: "Initech",
  location: "New York, NY",
  postedAt: hoursAgo(1),
  firstSeenAt: hoursAgo(1),
  url: `https://boards.greenhouse.io/initech/jobs/${id}`,
  fit: { score: 80, band: "queue", reason: "ok", stretch: false },
  ...over,
});

let server: Server;
let cookie: string;
let jobs: Row[];
let open: Awaited<ReturnType<JobsPorts["open"]>>;
let fail: boolean;
let reads: number;

beforeEach(async () => {
  jobs = [];
  open = [];
  fail = false;
  reads = 0;
  const ports: JobsPorts = {
    jobs: async () => {
      reads++;
      if (fail) throw new Error("connection refused (secret detail)");
      return jobs;
    },
    open: async () => open,
    now: () => NOW,
  };
  const sessions = createSessions(() => 0);
  cookie = `ns_session=${sessions.open().token}`;
  server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const config: ApiConfig = { signinKeySha256: HASH, port: portOf(server), webOrigin: WEB };
  server.on(
    "request",
    createApi({ config, sessions, extensionTokenSha256: EXT_HASH, extra: jobsEndpoints(ports) }),
  );
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const get = (query = "", headers: Record<string, string> = { cookie }): Promise<Sent> =>
  send(server, { method: "GET", path: `/jobs${query}`, headers });
const body = async (query = "") => JSON.parse((await get(query)).body);

describe("GET /jobs", () => {
  it("refuses no session and the extension token with 401, reading nothing", async () => {
    expect([
      (await get("", {})).status,
      (await get("", { authorization: "Bearer test-extension-token" })).status,
      reads,
    ]).toEqual([401, 401, 0]);
  });

  it("answers one job with only what the page shows", async () => {
    jobs = [job("1")];
    open = [{ id: "1", remote: "hybrid" }];
    expect(await body()).toEqual({
      role: null,
      more: false,
      jobs: [
        {
          rank: 1,
          title: "Backend Engineer",
          company: "Initech",
          location: "New York, NY",
          remote: "hybrid",
          ageHours: 1,
          fit: { score: 80, band: "queue", reason: "ok", stretch: false },
          url: "https://boards.greenhouse.io/initech/jobs/1",
        },
      ],
    });
  });

  it("orders by freshness times fit, the queue's own order", async () => {
    // Fresh and good, old but excellent (two days halves freshness twice), fresh but weak.
    jobs = [
      job("old", {
        postedAt: hoursAgo(48),
        fit: { score: 95, band: "queue", reason: "", stretch: false },
      }),
      job("weak", { fit: { score: 40, band: "skip", reason: "", stretch: false } }),
      job("good"),
    ];
    open = ["old", "weak", "good"].map((id) => ({ id, remote: null }));
    const res = await body();
    expect(res.jobs.map((j: { url: string }) => j.url.split("/").at(-1))).toEqual([
      "good",
      "weak",
      "old",
    ]);
  });

  it("leaves out drafts and jobs whose posting closed", async () => {
    jobs = [job("ready"), job("draft", { status: "draft" }), job("closed")];
    // A closed job isn't among the scorable ones.
    open = [
      { id: "ready", remote: null },
      { id: "draft", remote: null },
    ];
    const res = await body();
    expect(res.jobs.map((j: { url: string }) => j.url.split("/").at(-1))).toEqual(["ready"]);
  });

  it("filters to one role family, matching the directions' wording", async () => {
    jobs = [
      job("a", { title: "Senior Backend Engineer, Payments" }),
      job("b", { title: "Data Engineer" }),
    ];
    open = [
      { id: "a", remote: null },
      { id: "b", remote: null },
    ];
    const res = await body("?role=backend%20engineer");
    expect([res.role, res.jobs.map((j: { title: string }) => j.title)]).toEqual([
      "backend engineer",
      ["Senior Backend Engineer, Payments"],
    ]);
  });

  it("refuses a role longer than the directions ever show", async () => {
    expect((await get(`?role=${"a".repeat(201)}`)).status).toBe(400);
  });

  it("removes hidden characters from posting text and drops a link that isn't https", async () => {
    jobs = [job("1", { title: "Engineer‮​", company: "​", url: "javascript:alert(1)" })];
    open = [{ id: "1", remote: null }];
    const [j] = (await body()).jobs;
    expect([j.title, j.company, j.url]).toEqual(["Engineer", null, null]);
  });

  it(`lists at most ${JOBS_PAGE_MAX} jobs and says there are more`, async () => {
    jobs = Array.from({ length: JOBS_PAGE_MAX + 1 }, (_, i) => job(String(i)));
    open = jobs.map((j) => ({ id: j.id, remote: null }));
    const res = await body();
    expect([res.jobs.length, res.more]).toEqual([JOBS_PAGE_MAX, true]);
  });

  it("passes a fit reason only when it is one of the scorer's plain codes", async () => {
    const fit = (reason: string) => ({
      score: 50,
      band: "suggest" as const,
      reason,
      stretch: false,
    });
    jobs = [
      job("a", { fit: fit("below_threshold:mustHave") }),
      job("b", { fit: fit("<b>Click</b>") }),
    ];
    open = [
      { id: "a", remote: null },
      { id: "b", remote: null },
    ];
    const reasons = (await body()).jobs.map(
      (j: { fit: { reason: string | null } }) => j.fit.reason,
    );
    expect(reasons.sort()).toEqual(["below_threshold:mustHave", null].sort());
  });

  it("answers 503 when the jobs can't be read, never an empty list", async () => {
    fail = true;
    const res = await get();
    expect([res.status, res.body.includes("secret")]).toEqual([503, false]);
  });
});

describe("postingLink", () => {
  it("keeps https links and drops every other kind", () => {
    expect([
      postingLink("https://jobs.example.com/1"),
      postingLink("http://jobs.example.com/1"),
      postingLink("javascript:alert(1)"),
      postingLink("not a link"),
      postingLink("https://user:pass@jobs.example.com/1"),
      postingLink("HTTPS://Jobs.Example.com/1"),
    ]).toEqual([
      "https://jobs.example.com/1",
      null,
      null,
      null,
      null,
      "https://jobs.example.com/1",
    ]);
  });
});
