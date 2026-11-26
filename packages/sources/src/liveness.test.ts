import type { JobToCheck, PostingOutcome } from "@northstar/db";
import type { CallOutcome } from "@northstar/domain";
import { describe, expect, it } from "vitest";
import { type CheckPassDeps, checkPass, checkPosting } from "./liveness.js";
import { fakeWeb, type Page } from "./test/fake-web.js";

// Posting liveness (NS-173 slice 2, SRC-010). A fake web; synthetic boards and ids.

const GH = "https://boards.greenhouse.io/examplecorp/jobs/4001";
const GH_API = "https://boards-api.greenhouse.io/v1/boards/examplecorp/jobs/4001";
const LEVER = "https://jobs.lever.co/examplecorp/0a0a0a0a-0000-4000-8000-000000000002";
const LEVER_API =
  "https://api.lever.co/v0/postings/examplecorp/0a0a0a0a-0000-4000-8000-000000000002";
const SR = "https://jobs.smartrecruiters.com/ExampleCorp/7440001234567-backend-engineer";
const SR_API = "https://api.smartrecruiters.com/v1/companies/ExampleCorp/postings/7440001234567";
const ASHBY = "https://jobs.ashbyhq.com/examplecorp/0b0b0b0b-0000-4000-8000-000000000003";
const ASHBY_API = "https://api.ashbyhq.com/posting-api/job-board/examplecorp";
const ASHBY_ID = "0b0b0b0b-0000-4000-8000-000000000003";

const check = (pages: Record<string, Page>, url: string) => checkPosting(fakeWeb(pages).deps, url);

describe("checkPosting", () => {
  it("calls a posting its ATS still serves open", async () => {
    expect([
      await check({ [GH_API]: { body: { id: 4001 } } }, GH),
      await check({ [LEVER_API]: { body: { id: "x" } } }, LEVER),
      await check({ [SR_API]: { body: { id: "7440001234567" } } }, SR),
      await check({ [ASHBY_API]: { body: { jobs: [{ id: ASHBY_ID }] } } }, ASHBY),
    ]).toEqual(["open", "open", "open", "open"]);
  });

  it("calls a posting closed only on the ATS's own answer that it's gone", async () => {
    expect([
      await check({}, GH),
      await check({}, LEVER),
      await check({}, SR),
      await check({ [ASHBY_API]: { body: { jobs: [{ id: "other" }] } } }, ASHBY),
    ]).toEqual(["closed", "closed", "closed", "closed"]);
  });

  it("never closes a posting on a server error, a gone Ashby board or an unknown link", async () => {
    expect([
      await check({ [GH_API]: { status: 503 } }, GH),
      await check({}, ASHBY),
      await check({ [ASHBY_API]: { body: "not json" } }, ASHBY),
      await check({}, "https://www.example.com/careers/1"),
    ]).toEqual(["unavailable", "unavailable", "unavailable", "unavailable"]);
  });
});

function world(pages: Record<string, Page>, jobs: JobToCheck[]) {
  const web = fakeWeb(pages);
  const off = new Set<string>();
  const reports: { dependency: string; outcome: CallOutcome }[] = [];
  const recorded: [string, PostingOutcome][] = [];
  const deps: CheckPassDeps = {
    ...web.deps,
    guard: {
      isOn: async (s) => !off.has(s),
      acquire: async () => ({ allowed: true, probe: false }),
      report: async (dependency, outcome) => {
        reports.push({ dependency, outcome });
      },
    },
    store: {
      due: async () => jobs,
      record: async (job, outcome) => {
        recorded.push([job.jobId, outcome]);
        return { closedNow: outcome === "closed" };
      },
    },
  };
  return { deps, off, reports, recorded, asked: web.asked };
}

const NOW = new Date("2026-11-26T12:00:00Z");

describe("checkPass", () => {
  it("records answered checks, stores nothing for an unavailable one, and counts each", async () => {
    const w = world({ [GH_API]: { body: { id: 4001 } }, [SR_API]: { status: 500 } }, [
      { jobId: "j1", ats: "greenhouse", url: GH },
      { jobId: "j2", ats: "lever", url: LEVER },
      { jobId: "j3", ats: "smartrecruiters", url: SR },
    ]);
    expect([await checkPass(w.deps, NOW), w.recorded]).toEqual([
      { checked: 3, open: 1, closed: 1, unavailable: 1, heldBack: 0 },
      [
        ["j1", "open"],
        ["j2", "closed"],
      ],
    ]);
  });

  it("tells the breaker a 404 is the ATS answering and a 5xx is a failure", async () => {
    const w = world({ [SR_API]: { status: 500 } }, [
      { jobId: "j2", ats: "lever", url: LEVER },
      { jobId: "j3", ats: "smartrecruiters", url: SR },
    ]);
    await checkPass(w.deps, NOW);
    expect(w.reports).toEqual([
      { dependency: "source:lever", outcome: { ok: true } },
      { dependency: "source:smartrecruiters", outcome: { ok: false, error: "Unavailable" } },
    ]);
  });

  it("holds back an ATS whose kill switch is off, without a request", async () => {
    const w = world({}, [{ jobId: "j1", ats: "greenhouse", url: GH }]);
    w.off.add("source:greenhouse");
    expect([await checkPass(w.deps, NOW), w.asked, w.recorded]).toEqual([
      { checked: 0, open: 0, closed: 0, unavailable: 0, heldBack: 1 },
      [],
      [],
    ]);
  });
});
