import type { JobToCheck, PostingOutcome } from "@northstar/db";
import type { CallDecision, CallOutcome } from "@northstar/domain";
import { describe, expect, it } from "vitest";
import { type CheckPassDeps, checkPass, checkPosting, checkTarget } from "./liveness.js";
import { fakeWeb, type Page } from "./test/fake-web.js";

// Posting liveness (NS-173 slice 2, SRC-010). A fake web; synthetic boards and ids.

const GH = "https://boards.greenhouse.io/examplecorp/jobs/4001";
const GH_API = "https://boards-api.greenhouse.io/v1/boards/examplecorp/jobs/4001";
const LEVER = "https://jobs.lever.co/examplecorp/0a0a0a0a-0000-4000-8000-000000000002";
const LEVER_EU = "https://jobs.eu.lever.co/examplecorp/0a0a0a0a-0000-4000-8000-000000000002";
const LEVER_API =
  "https://api.lever.co/v0/postings/examplecorp/0a0a0a0a-0000-4000-8000-000000000002";
const SR = "https://jobs.smartrecruiters.com/ExampleCorp/7440001234567-backend-engineer";
const SR_API = "https://api.smartrecruiters.com/v1/companies/ExampleCorp/postings/7440001234567";
const ASHBY = (id: string) => `https://jobs.ashbyhq.com/examplecorp/${id}`;
const ASHBY_API = "https://api.ashbyhq.com/posting-api/job-board/examplecorp";
const A1 = "0b0b0b0b-0000-4000-8000-000000000003";
const A2 = "0b0b0b0b-0000-4000-8000-000000000004";

const check = async (pages: Record<string, Page>, url: string) =>
  checkPosting(fakeWeb(pages).deps, url);

describe("checkPosting", () => {
  it("calls a posting its ATS still serves open", async () => {
    expect([
      await check({ [GH_API]: { body: { id: 4001 } } }, GH),
      await check({ [LEVER_API]: { body: { id: "x" } } }, LEVER),
      await check({ [SR_API]: { body: { id: "7440001234567" } } }, SR),
      await check({ [ASHBY_API]: { body: { jobs: [{ id: A1 }] } } }, ASHBY(A1)),
    ]).toEqual(Array(4).fill({ liveness: "open", failed: false, requested: true }));
  });

  it("calls a posting closed only on the ATS's own answer that it's gone", async () => {
    expect([
      await check({}, GH),
      await check({}, LEVER),
      await check({}, SR),
      await check({ [ASHBY_API]: { body: { jobs: [{ id: "other" }] } } }, ASHBY(A1)),
    ]).toEqual(Array(4).fill({ liveness: "closed", failed: false, requested: true }));
  });

  it("never closes on a server error, a gone Ashby board or an unknown link", async () => {
    expect([
      await check({ [GH_API]: { status: 503 } }, GH),
      await check({}, ASHBY(A1)),
      await check({ [ASHBY_API]: { body: "not json" } }, ASHBY(A1)),
      await check({}, "https://www.example.com/careers/1"),
    ]).toEqual([
      { liveness: "unavailable", failed: true, requested: true },
      { liveness: "unavailable", failed: false, requested: true },
      { liveness: "unavailable", failed: false, requested: true },
      { liveness: "unavailable", failed: false, requested: false },
    ]);
  });

  it("doesn't check an EU Lever posting against the US API", async () => {
    const web = fakeWeb({});
    expect([checkTarget(LEVER_EU), await checkPosting(web.deps, LEVER_EU), web.asked]).toEqual([
      null,
      { liveness: "unavailable", failed: false, requested: false },
      [],
    ]);
  });
});

function world(pages: Record<string, Page>, jobs: JobToCheck[]) {
  const web = fakeWeb(pages);
  const off = new Set<string>();
  const decisions = new Map<string, CallDecision>();
  const reports: { dependency: string; outcome: CallOutcome }[] = [];
  const recorded: [string, PostingOutcome][] = [];
  let failSave = false;
  const deps: CheckPassDeps = {
    ...web.deps,
    guard: {
      isOn: async (s) => !off.has(s),
      acquire: async (d) => decisions.get(d) ?? { allowed: true, probe: false },
      report: async (dependency, outcome) => {
        reports.push({ dependency, outcome });
      },
    },
    store: {
      due: async () => jobs,
      record: async (job, outcome) => {
        if (failSave) throw new Error("database down");
        recorded.push([job.jobId, outcome]);
        return { closedNow: false, reopenedNow: false };
      },
    },
  };
  return {
    deps,
    off,
    decisions,
    reports,
    recorded,
    asked: web.asked,
    failSaves: () => (failSave = true),
  };
}

const NOW = new Date("2026-11-26T12:00:00Z");
const zero = { checked: 0, open: 0, closed: 0, unavailable: 0, heldBack: 0, unchecked: 0 };

describe("checkPass", () => {
  it("records every attempt, unavailable included, and counts each", async () => {
    const w = world({ [GH_API]: { body: { id: 4001 } }, [SR_API]: { status: 500 } }, [
      { jobId: "j1", ats: "greenhouse", url: GH },
      { jobId: "j2", ats: "lever", url: LEVER },
      { jobId: "j3", ats: "smartrecruiters", url: SR },
    ]);
    expect([await checkPass(w.deps, NOW), w.recorded]).toEqual([
      { ...zero, checked: 3, open: 1, closed: 1, unavailable: 1 },
      [
        ["j1", "open"],
        ["j2", "closed"],
        ["j3", "unavailable"],
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

  it("reads an Ashby board once for all its jobs in a pass", async () => {
    const w = world({ [ASHBY_API]: { body: { jobs: [{ id: A1 }] } } }, [
      { jobId: "j1", ats: "ashby", url: ASHBY(A1) },
      { jobId: "j2", ats: "ashby", url: ASHBY(A2) },
    ]);
    await checkPass(w.deps, NOW);
    expect([w.asked, w.recorded, w.reports]).toEqual([
      [ASHBY_API],
      [
        ["j1", "open"],
        ["j2", "closed"],
      ],
      [{ dependency: "source:ashby", outcome: { ok: true } }],
    ]);
  });

  it("counts one failed Ashby board read against the breaker once, not once per job", async () => {
    const w = world({ [ASHBY_API]: { status: 503 } }, [
      { jobId: "j1", ats: "ashby", url: ASHBY(A1) },
      { jobId: "j2", ats: "ashby", url: ASHBY(A2) },
    ]);
    await checkPass(w.deps, NOW);
    expect(w.reports).toEqual([
      { dependency: "source:ashby", outcome: { ok: false, error: "Unavailable" } },
    ]);
  });

  it("holds back an ATS whose kill switch is off or whose breaker refuses, without a request", async () => {
    const w = world({}, [
      { jobId: "j1", ats: "greenhouse", url: GH },
      { jobId: "j2", ats: "lever", url: LEVER },
    ]);
    w.off.add("source:greenhouse");
    w.decisions.set("source:lever", { allowed: false, retryAt: NOW, lastError: null });
    expect([await checkPass(w.deps, NOW), w.asked, w.recorded]).toEqual([
      { ...zero, heldBack: 2 },
      [],
      [],
    ]);
  });

  it("skips a link with no API to ask, or whose ATS doesn't match, touching no breaker", async () => {
    const w = world({}, [
      { jobId: "j1", ats: "lever", url: LEVER_EU },
      { jobId: "j2", ats: "greenhouse", url: LEVER },
    ]);
    expect([await checkPass(w.deps, NOW), w.asked, w.reports, w.recorded]).toEqual([
      { ...zero, unchecked: 2 },
      [],
      [],
      [
        ["j1", "unavailable"],
        ["j2", "unavailable"],
      ],
    ]);
  });

  it("goes on when saving one result fails", async () => {
    const w = world({ [GH_API]: { body: { id: 4001 } }, [LEVER_API]: { body: {} } }, [
      { jobId: "j1", ats: "greenhouse", url: GH },
      { jobId: "j2", ats: "lever", url: LEVER },
    ]);
    w.failSaves();
    expect(await checkPass(w.deps, NOW)).toEqual({ ...zero, checked: 2, unavailable: 2 });
  });
});
