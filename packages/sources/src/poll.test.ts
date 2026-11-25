import type { DedupeCandidate, NextState, PollResult, SaveResult, Watch } from "@northstar/db";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { nextState, type PollDeps, pollDue } from "./poll.js";
import { fakeWeb, type Page } from "./test/fake-web.js";

// Synthetic boards and postings only (invented companies and ids).
const T0 = new Date("2026-11-25T12:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const GH =
  "https://boards-api.greenhouse.io/v1/boards/globex/jobs?content=true&pay_transparency=true";
const LEVER = "https://api.lever.co/v0/postings/initech?mode=json";

const ghJob = (id: number, title = `Engineer ${id}`, location = `Office ${id}`) => ({
  id,
  title,
  company_name: "Globex",
  location: { name: location },
  first_published: "2026-11-25T11:00:00Z",
});

const watch = (over: Partial<Watch>): Watch => ({
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
  ...over,
});

// An in-memory watchlist and job store: what packages/db does, without a database.
function world(pages: Record<string, Page>, watches: Watch[]) {
  const web = fakeWeb(pages);
  const jobs: DedupeCandidate[] = [];
  const recorded: { watchId: string; result: PollResult; next: NextState }[] = [];
  const deps: PollDeps = {
    ...web.deps,
    store: {
      due: async (now) => watches.filter((w) => w.status !== "quarantined" && w.nextPollAt <= now),
      candidates: async () => structuredClone(jobs),
      save: async ({ fields, source, mergeInto }): Promise<SaveResult> => {
        const existing = jobs.find((j) => j.jobId === mergeInto);
        if (existing) {
          existing.sources.push(source);
          return { status: "merged", jobId: existing.jobId };
        }
        const jobId = `job-${jobs.length + 1}`;
        jobs.push({
          jobId,
          company: fields.company,
          title: fields.title,
          location: fields.location,
          description: fields.description,
          sources: [source],
        });
        return { status: "created", jobId };
      },
      record: async (w, _now, result, next) => {
        recorded.push({ watchId: w.id, result, next });
        Object.assign(w, {
          ...next,
          consecutiveFailures: next.consecutiveFailures,
        });
      },
    },
  };
  return { deps, jobs, recorded, pages, asked: web.asked };
}

const exporter = new InMemorySpanExporter();
beforeAll(() => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});
beforeEach(() => exporter.reset());

describe("pollDue", () => {
  it("saves every posting on a board's first poll and schedules the next by tier", async () => {
    const w = world({ [GH]: { body: { jobs: [ghJob(1), ghJob(2)] } } }, [watch({})]);
    const summary = await pollDue(w.deps, T0);
    expect(summary).toEqual({ boards: 1, added: 2, failed: 0, quarantined: 0 });
    expect(w.jobs.map((j) => j.title)).toEqual(["Engineer 1", "Engineer 2"]);
    expect(w.recorded[0]).toEqual({
      watchId: "w-globex",
      result: { outcome: "ok", seen: 2, added: 2, failed: 0, errorName: null },
      next: { nextPollAt: at(10), status: "ok", consecutiveFailures: 0 },
    });
  });

  it("polling the same board twice adds nothing the second time", async () => {
    const w = world({ [GH]: { body: { jobs: [ghJob(1), ghJob(2)] } } }, [watch({})]);
    await pollDue(w.deps, T0);
    const second = await pollDue(w.deps, at(10));
    expect(second.added).toBe(0);
    expect(w.jobs).toHaveLength(2);
    expect(w.recorded[1]?.result).toEqual({
      outcome: "ok",
      seen: 2,
      added: 0,
      failed: 0,
      errorName: null,
    });
  });

  it("a posting first added from a pasted link is not added again from its board", async () => {
    const w = world({ [GH]: { body: { jobs: [ghJob(7)] } } }, [watch({})]);
    w.jobs.push({
      jobId: "pasted",
      // Different words and link, same ATS posting id: only the id can match them.
      company: "Globex Inc",
      title: "Senior Engineer",
      location: "Elsewhere",
      description: null,
      sources: [
        {
          url: "https://globex.example.com/careers?gh_jid=7",
          ats: "greenhouse",
          atsPostingId: "7",
        },
      ],
    });
    expect((await pollDue(w.deps, T0)).added).toBe(0);
    expect(w.jobs).toHaveLength(1);
  });

  it("a SmartRecruiters posting pasted with its title in the link is matched by id, not added twice", async () => {
    const SR = "https://api.smartrecruiters.com/v1/companies/Acme/postings?limit=100";
    const w = world({ [SR]: { body: { content: [{ id: "744000012345678", name: "SRE" }] } } }, [
      watch({ id: "w-acme", ats: "smartrecruiters", board: "Acme" }),
    ]);
    w.jobs.push({
      jobId: "pasted",
      company: null,
      title: "Site Reliability Engineer",
      location: null,
      description: null,
      sources: [
        {
          url: "https://jobs.smartrecruiters.com/Acme/744000012345678-site-reliability-engineer",
          ats: "smartrecruiters",
          atsPostingId: "744000012345678",
        },
      ],
    });
    expect((await pollDue(w.deps, T0)).added).toBe(0);
  });

  it("one posting that can't be saved is counted, and the board's other postings still save", async () => {
    const w = world({ [GH]: { body: { jobs: [ghJob(1), ghJob(2), ghJob(3)] } } }, [watch({})]);
    const save = w.deps.store.save;
    w.deps.store.save = async (input) => {
      if (input.fields.title === "Engineer 2")
        throw Object.assign(new Error("x"), { name: "CheckViolation" });
      return save(input);
    };
    const summary = await pollDue(w.deps, T0);
    expect(summary).toEqual({ boards: 1, added: 2, failed: 0, quarantined: 0 });
    expect(w.recorded[0]?.result).toEqual({
      outcome: "ok",
      seen: 3,
      added: 2,
      failed: 1,
      errorName: "CheckViolation",
    });
    expect(w.recorded[0]?.next.status).toBe("ok");
  });

  it("when every new posting fails to save (the database is down), the board fails", async () => {
    const w = world({ [GH]: { body: { jobs: [ghJob(1), ghJob(2)] } } }, [watch({})]);
    w.deps.store.save = async () => {
      throw Object.assign(new Error("x"), { name: "DbDown" });
    };
    expect((await pollDue(w.deps, T0)).failed).toBe(1);
    expect(w.recorded[0]?.result).toEqual({
      outcome: "failed",
      seen: 2,
      added: 0,
      failed: 2,
      errorName: "DbDown",
    });
  });

  it("polls only boards that are due", async () => {
    const w = world({ [GH]: { body: { jobs: [] } }, [LEVER]: { body: [] } }, [
      watch({}),
      watch({ id: "w-initech", ats: "lever", board: "initech", nextPollAt: at(5) }),
    ]);
    await pollDue(w.deps, T0);
    expect(w.asked).toEqual([GH]);
  });

  it("a failing board backs off, and the other boards still poll in the same pass", async () => {
    const w = world({ [GH]: { status: 503, body: "busy" }, [LEVER]: { body: [] } }, [
      watch({}),
      watch({ id: "w-initech", ats: "lever", board: "initech", tier: 2 }),
    ]);
    const summary = await pollDue(w.deps, T0);
    expect(summary).toEqual({ boards: 2, added: 0, failed: 1, quarantined: 0 });
    expect(w.recorded.map((r) => [r.watchId, r.result.outcome, r.next.status])).toEqual([
      ["w-globex", "failed", "backing_off"],
      ["w-initech", "ok", "ok"],
    ]);
    expect(w.recorded[0]?.result.errorName).toBe("BoardUnavailable");
  });
});

describe("nextState", () => {
  it("doubles the interval per consecutive failure, capped at 6 hours", () => {
    const minutes = [0, 1, 2, 3, 4, 5].map((failures) => {
      const next = nextState(watch({ tier: 3, consecutiveFailures: failures }), false, T0);
      return (next.nextPollAt.getTime() - T0.getTime()) / 60_000;
    });
    expect(minutes).toEqual([120, 240, 360, 360, 360, 360]);
  });

  it("quarantines a board on its fifth consecutive failure", () => {
    expect(nextState(watch({ consecutiveFailures: 3 }), false, T0)).toMatchObject({
      status: "backing_off",
      consecutiveFailures: 4,
    });
    expect(nextState(watch({ consecutiveFailures: 4 }), false, T0)).toMatchObject({
      status: "quarantined",
      consecutiveFailures: 5,
    });
  });

  it("a success clears the failures and returns to the tier's cadence", () => {
    expect(nextState(watch({ tier: 2, consecutiveFailures: 3 }), true, T0)).toEqual({
      nextPollAt: at(20),
      status: "ok",
      consecutiveFailures: 0,
    });
  });
});

describe("freshness SLO (SRC-012, simulated clock)", () => {
  it("a posting that appears on a tier-1 board is stored within 11 minutes", async () => {
    const w = world({ [GH]: { body: { jobs: [] } } }, [watch({})]);
    let storedAt: number | null = null;
    // `jobs run` ticks once a minute; the posting goes up one minute after a poll.
    for (let minute = 0; minute <= 30 && storedAt === null; minute++) {
      if (minute === 1) w.pages[GH] = { body: { jobs: [ghJob(99)] } };
      await pollDue(w.deps, at(minute));
      if (w.jobs.length > 0) storedAt = minute;
    }
    expect(storedAt).not.toBeNull();
    expect((storedAt ?? 99) - 1).toBeLessThanOrEqual(11);
  });
});

// What a real watch id looks like: random, unrelated to the board.
const WATCH_UUID = "5b1e7c2a-0d3f-4a9b-8c6e-2f4a1b9d7e30";

describe("source.poll span", () => {
  it("records the ATS, the watch's random id, outcome and counts, never the board's name", async () => {
    const w = world({ [GH]: { body: { jobs: [ghJob(1)] } } }, [watch({ id: WATCH_UUID })]);
    await pollDue(w.deps, T0);
    const span = exporter.getFinishedSpans().find((s) => s.name === "source.poll");
    expect(span?.attributes).toMatchObject({
      "source.ats": "greenhouse",
      "source.outcome": "ok",
      "source.seen": 1,
      "source.added": 1,
    });
    // The watch id, not a hash: board names are short and public, so a hash could be reversed.
    expect(span?.attributes["source.watch_id"]).toBe(WATCH_UUID);
    expect(JSON.stringify(span?.attributes)).not.toContain("globex");
  });
});
