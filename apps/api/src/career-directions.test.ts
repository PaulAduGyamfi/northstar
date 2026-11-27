import { createServer, type Server } from "node:http";
import type { ScoringProfile } from "@northstar/db";
import type { DirectionJob } from "@northstar/sources";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  careerDirectionsEndpoints,
  type DirectionDimension,
  type DirectionsPorts,
  directionJobs,
  POSTING_TEXT_MAX,
  postingText,
} from "./career-directions.js";
import type { ApiConfig } from "./config.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";
import { portOf, type Sent, send } from "./test/http.js";

// Directions and evidence gaps on the Career DNA page (NS-130 slice 9) over a real http server,
// with the readers faked and the real matcher and gap rules. Invented work, jobs and ids only.
const HASH = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")
const EXT_HASH = "2f50a0607c1fb6606c98272169b134502f7c188b1e17f3d1579320aa3e3fb6c4";
const WEB = "http://northstar.localhost:3100";
const ATOM = "00000000-0000-4000-8000-0000000000a1";
const JOB_A = "00000000-0000-4000-8000-0000000000c1";
const JOB_B = "00000000-0000-4000-8000-0000000000c2";
const NOW = new Date("2026-11-27T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

const PROFILE: ScoringProfile = {
  sourceId: "00000000-0000-4000-8000-0000000000d1",
  atoms: [{ id: ATOM, what: "Built the billing service.", how: ["Go"] }],
  skills: [],
};

// Two backend jobs: one fresh, one a month old. Both ask for Go (matched) and Kafka (a gap).
const JOBS: DirectionJob[] = [
  {
    id: JOB_A,
    title: "Senior Backend Engineer",
    requirements: ["Go", "Kafka"],
    postedAt: daysAgo(2),
  },
  { id: JOB_B, title: "Backend Engineer II", requirements: ["Go", "Kafka"], postedAt: daysAgo(30) },
];

const DIMENSIONS: DirectionDimension[] = [
  { key: "engineering", label: "Engineering", band: "high", points: 12, evidenceCount: 10 },
  { key: "leadership", label: "Leadership", band: "not_enough", points: null, evidenceCount: 1 },
];

let server: Server;
let cookie: string;
let profile: ScoringProfile | null;
let jobs: DirectionJob[];
let dimensions: DirectionDimension[];
let tracks: Awaited<ReturnType<DirectionsPorts["tracks"]>>;
let failJobs: boolean;
let reads: number;

beforeEach(async () => {
  profile = PROFILE;
  jobs = JOBS;
  dimensions = DIMENSIONS;
  tracks = [];
  failJobs = false;
  reads = 0;
  const ports: DirectionsPorts = {
    profile: async () => {
      reads++;
      return profile;
    },
    jobs: async () => {
      if (failJobs) throw new Error("connection refused (secret detail)");
      return jobs;
    },
    dimensions: async () => dimensions,
    tracks: async () => tracks,
    now: () => NOW,
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
      extra: careerDirectionsEndpoints(ports),
    }),
  );
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const get = (headers: Record<string, string> = { cookie }): Promise<Sent> =>
  send(server, { method: "GET", path: "/career-dna/directions", headers });

describe("GET /career-dna/directions", () => {
  it("refuses no session and the extension token with 401, reading nothing", async () => {
    expect([
      (await get({})).status,
      (await get({ authorization: "Bearer test-extension-token" })).status,
      reads,
    ]).toEqual([401, 401, 0]);
  });

  it("answers no directions before a resume is imported", async () => {
    profile = null;
    const res = await get();
    expect([res.status, JSON.parse(res.body)]).toEqual([200, { directions: null }]);
  });

  it("answers each direction's coverage, matched atoms, gaps and fresh jobs, then the proof to build", async () => {
    const res = await get();
    expect([res.status, JSON.parse(res.body)]).toEqual([
      200,
      {
        directions: {
          hasReport: true,
          list: [
            {
              rank: 1,
              role: "backend engineer",
              jobCount: 2,
              coverage: 50,
              matchedAtoms: 1,
              gaps: [{ requirement: "Kafka", jobs: 2 }],
              freshJobs: 1,
            },
          ],
          gaps: [
            {
              rank: 1,
              kind: "dimension",
              label: "Leadership",
              band: "not_enough",
              evidenceCount: 1,
            },
            {
              rank: 2,
              kind: "requirement",
              requirement: "Kafka",
              role: "backend engineer",
              jobs: 2,
              share: 100,
            },
          ],
        },
      },
    ]);
  });

  it("leaves out a gap an active growth track already names", async () => {
    tracks = [{ name: "Kafka", status: "active" }];
    const body = JSON.parse((await get()).body);
    expect(body.directions.gaps).toEqual([
      { rank: 1, kind: "dimension", label: "Leadership", band: "not_enough", evidenceCount: 1 },
    ]);
  });

  it("says there is no report yet and suggests requirement gaps only", async () => {
    dimensions = [];
    const body = JSON.parse((await get()).body);
    expect([
      body.directions.hasReport,
      body.directions.gaps.map((g: { kind: string }) => g.kind),
    ]).toEqual([false, ["requirement"]]);
  });

  it("never carries an atom id or a job id", async () => {
    const res = await get();
    expect([res.body.includes(ATOM), res.body.includes(JOB_A), res.body.includes(JOB_B)]).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("shows a posting's requirement cleaned of hidden characters and cut to length", async () => {
    const long = `Kaf\u200bka\u202e ${"x".repeat(300)}`;
    jobs = JOBS.map((j) => ({ ...j, requirements: ["Go", long] }));
    const body = JSON.parse((await get()).body);
    const shown: string = body.directions.list[0].gaps[0].requirement;
    expect([shown.startsWith("Kafka x"), Array.from(shown).length]).toEqual([
      true,
      POSTING_TEXT_MAX,
    ]);
  });

  it("answers 503 when a reader fails, never an empty list or the failure's detail", async () => {
    failJobs = true;
    const res = await get();
    expect([res.status, res.body.includes("secret detail")]).toEqual([503, false]);
  });
});

describe("postingText", () => {
  it("removes the blank-looking characters a posting could pad a line with", () => {
    // Hangul fillers, the halfwidth filler, the braille blank, the grapheme joiner and selectors.
    expect(postingText("Go\u3164 \u115f\u1160and\u2800 Ru\u034fst\ufe0f \uffa0APIs\u{e0100}")).toBe(
      "Go and Rust APIs",
    );
  });

  it("turns a filler or braille blank used alone between words into a space, never joining them", () => {
    expect([postingText("Senior\u3164Engineer"), postingText("Go\u2800Rust\uffa0APIs")]).toEqual([
      "Senior Engineer",
      "Go Rust APIs",
    ]);
  });

  it("leaves letters, digits and ordinary punctuation alone", () => {
    expect(postingText("Café · C++ / Node.js (5+ years) — 한국어")).toBe(
      "Café · C++ / Node.js (5+ years) — 한국어",
    );
  });

  it("removes control, format and separator characters and collapses spaces", () => {
    expect(postingText("  Go\u0007 and\u2028 \u200dRust\u00ad\t\tAPIs ")).toBe("Go and Rust APIs");
  });

  it("cuts by whole code points, never leaving half of a pair", () => {
    const shown = postingText("😀".repeat(POSTING_TEXT_MAX + 5));
    expect([Array.from(shown).length, shown.endsWith("😀")]).toEqual([POSTING_TEXT_MAX, true]);
  });
});

describe("directionJobs", () => {
  it("dates each job by its posting, else by when it was first seen, and an unlisted one not at all", () => {
    const seen = daysAgo(3);
    const posted = daysAgo(10);
    const scorable = [
      { id: JOB_A, title: "Backend Engineer", requirements: ["Go"] },
      { id: JOB_B, title: "Backend Engineer", requirements: ["Kafka"] },
      { id: ATOM, title: null, requirements: [] },
    ];
    const listed = [
      { id: JOB_B, postedAt: null, firstSeenAt: seen },
      { id: JOB_A, postedAt: posted, firstSeenAt: seen },
    ];
    expect(directionJobs(scorable, listed).map((j) => [j.id, j.postedAt])).toEqual([
      [JOB_A, posted],
      [JOB_B, seen],
      [ATOM, null],
    ]);
  });
});
