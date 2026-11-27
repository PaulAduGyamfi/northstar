import { createServer, type Server } from "node:http";
import type { CareerDnaSnapshot, StoredCareerDna } from "@northstar/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CareerDnaPorts, careerDnaEndpoints } from "./career-dna.js";
import type { ApiConfig } from "./config.js";
import { createApi } from "./server.js";
import { createSessions } from "./sessions.js";
import { portOf, type Sent, send } from "./test/http.js";

// The Career DNA page's API (NS-130 slice 8) over a real http server, with the stored history and
// the report's diff wording faked. Invented reports and ids only.
const HASH = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")
const EXT_HASH = "2f50a0607c1fb6606c98272169b134502f7c188b1e17f3d1579320aa3e3fb6c4";
const WEB = "http://northstar.localhost:3100";
const ATOM = "00000000-0000-4000-8000-0000000000a1";
const STORY = "00000000-0000-4000-8000-0000000000b1";

function stored(version: number, band: "medium" | "high", points: number): StoredCareerDna {
  return {
    id: `00000000-0000-4000-8000-00000000000${version}`,
    version,
    createdAt: new Date(`2026-11-2${version}T10:00:00.000Z`),
    rubricVersion: 1,
    family: "software_engineering",
    dimensions: [
      {
        key: "engineering",
        band,
        points,
        evidenceCount: points,
        atomIds: [ATOM],
        storyIds: [STORY],
      },
      {
        key: "retired_dimension",
        band: "not_enough",
        points: null,
        evidenceCount: 1,
        atomIds: [],
        storyIds: [],
      },
    ],
    archetype: { label: "Builder", dimensions: ["engineering"] },
  };
}

let server: Server;
let cookie: string;
let history: StoredCareerDna[];
let reads: number;
let described: [CareerDnaSnapshot | null, CareerDnaSnapshot][];
let failRead: boolean;

beforeEach(async () => {
  reads = 0;
  described = [];
  failRead = false;
  history = [];
  const ports: CareerDnaPorts = {
    history: async () => {
      reads++;
      if (failRead) throw new Error("connection refused (secret detail)");
      return history;
    },
    describe: (previous, next) => {
      described.push([previous, next]);
      return previous === null
        ? { first: true, changes: [] }
        : { first: false, changes: ["Engineering moved up from Medium to High."] };
    },
    labelOf: (key) => (key === "engineering" ? "Engineering" : null),
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
      extra: careerDnaEndpoints(ports),
    }),
  );
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const get = (headers: Record<string, string> = { cookie }): Promise<Sent> =>
  send(server, { method: "GET", path: "/career-dna", headers });

describe("GET /career-dna", () => {
  it("refuses no session and the extension token with 401, reading nothing", async () => {
    expect([
      (await get({})).status,
      (await get({ authorization: "Bearer test-extension-token" })).status,
      reads,
    ]).toEqual([401, 401, 0]);
  });

  it("answers no report before any is stored", async () => {
    const res = await get();
    expect([res.status, JSON.parse(res.body)]).toEqual([200, { report: null }]);
  });

  it("answers the newest version's dimensions and what changed since the one before it", async () => {
    history = [stored(3, "high", 11), stored(2, "medium", 7)];
    const res = await get();
    expect([res.status, JSON.parse(res.body)]).toEqual([
      200,
      {
        report: {
          version: 3,
          createdAt: "2026-11-23T10:00:00.000Z",
          label: "Builder",
          dimensions: [
            {
              key: "engineering",
              label: "Engineering",
              band: "high",
              points: 11,
              evidenceCount: 11,
            },
            {
              key: "retired_dimension",
              label: null,
              band: "not_enough",
              points: null,
              evidenceCount: 1,
            },
          ],
          first: false,
          changes: ["Engineering moved up from Medium to High."],
        },
      },
    ]);
    // The diff compares the newest with the version right before it.
    expect(
      described.map(([p, n]) => [
        p && (p as StoredCareerDna).version,
        (n as StoredCareerDna).version,
      ]),
    ).toEqual([[2, 3]]);
  });

  it("marks a lone version as the first report", async () => {
    history = [stored(1, "medium", 7)];
    const body = JSON.parse((await get()).body);
    expect([body.report.first, body.report.changes, described[0]?.[0]]).toEqual([true, [], null]);
  });

  // The server re-parses every answer through the output schema, which drops unknown keys, so this
  // guards that layer as well as the handler's field-by-field copy.
  it("never sends a stored atom or story id", async () => {
    history = [stored(3, "high", 11), stored(2, "medium", 7)];
    const res = await get();
    expect([res.body.includes(ATOM), res.body.includes(STORY)]).toEqual([false, false]);
  });

  it("answers 503 unavailable when the history can't be read, quoting nothing of the error", async () => {
    failRead = true;
    const res = await get();
    expect([res.status, res.body.includes("secret detail")]).toEqual([503, false]);
  });
});
