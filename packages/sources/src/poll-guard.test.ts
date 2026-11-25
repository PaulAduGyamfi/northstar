import {
  type Db,
  type DedupeCandidate,
  type NextState,
  type PollResult,
  readBreakers,
  setKillSwitch,
  soleCandidate,
  type Watch,
} from "@northstar/db";
import { createTestDb } from "@northstar/db/testing";
import type { CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PollDeps, pollDue } from "./poll.js";
import { dbPollGuard } from "./poll-guard.js";
import { fakeWeb, type Page } from "./test/fake-web.js";

// pollDue with its guard on the real kill switches and breakers (PGlite). The watchlist and job
// store are in memory; boards and postings are synthetic.

const T0 = new Date("2026-11-25T12:00:00Z");
const GH =
  "https://boards-api.greenhouse.io/v1/boards/globex/jobs?content=true&pay_transparency=true";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  candidateId = await soleCandidate(db);
});

afterEach(async () => {
  await close();
});

const globex: Watch = {
  id: "w-globex",
  ats: "greenhouse",
  board: "globex",
  url: "https://boards.greenhouse.io/globex",
  tier: 1,
  status: "ok",
  nextPollAt: T0,
  lastPolledAt: null,
  lastSuccessAt: null,
  consecutiveFailures: 0,
  lastError: null,
  jobsFound: 0,
};

// A board that is always due (its own backoff isn't under test here), on a fake web.
function setup(page: Page) {
  const web = fakeWeb({ [GH]: page });
  const recorded: PollResult[] = [];
  const jobs: DedupeCandidate[] = [];
  const deps: PollDeps = {
    ...web.deps,
    guard: dbPollGuard(db, candidateId),
    store: {
      due: async () => [{ ...globex }],
      candidates: async () => jobs,
      save: async () => ({ status: "created", jobId: `job-${jobs.length + 1}` }),
      record: async (_w: Watch, _now: Date, result: PollResult, _next: NextState) => {
        recorded.push(result);
      },
    },
  };
  return { deps, asked: web.asked, recorded };
}

describe("board polling on the stored kill switches and breakers", () => {
  it("switching source:greenhouse off holds the board back, and switching it on reads it again", async () => {
    const s = setup({ body: { jobs: [] } });
    await setKillSwitch(db, {
      candidateId,
      subsystem: "source:greenhouse",
      enabled: false,
      actor: "user",
      reason: "Pausing Greenhouse boards",
    });
    expect(await pollDue(s.deps, T0)).toEqual({
      boards: 1,
      added: 0,
      failed: 0,
      quarantined: 0,
      paused: 1,
    });
    expect(s.asked).toEqual([]);
    await setKillSwitch(db, {
      candidateId,
      subsystem: "source:greenhouse",
      enabled: true,
      actor: "user",
      reason: "Greenhouse is fine again",
    });
    await pollDue(s.deps, T0);
    expect(s.asked).toEqual([GH]);
  });

  it("five failed reads open the ATS's breaker, and the next pass doesn't call the board", async () => {
    const s = setup({ status: 503, body: "busy" });
    for (let i = 0; i < 5; i++) await pollDue(s.deps, T0);
    const [breaker] = await readBreakers(db, candidateId);
    expect(breaker?.dependency).toBe("source:greenhouse");
    expect(breaker?.status).toBe("open");
    expect(breaker?.lastError).toBe("BoardUnavailable");
    const summary = await pollDue(s.deps, T0);
    expect(summary.paused).toBe(1);
    expect(s.asked).toHaveLength(5);
  });

  it("a successful read leaves the breaker closed with no failures", async () => {
    const s = setup({ body: { jobs: [] } });
    await pollDue(s.deps, T0);
    const [breaker] = await readBreakers(db, candidateId);
    expect(breaker?.status).toBe("closed");
    expect(breaker?.consecutiveFailures).toBe(0);
  });
});
