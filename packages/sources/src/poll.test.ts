import type { DedupeCandidate, NextState, PollResult, SaveResult, Watch } from "@northstar/db";
import type { CallDecision, CallOutcome } from "@northstar/domain";
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

// Kill switches and breakers in memory: every subsystem on and every call allowed unless a test
// says otherwise. `reports` keeps what pollDue told the breaker, in order.
function fakeGuard() {
  const off = new Set<string>();
  const decisions = new Map<string, CallDecision>();
  const reports: { dependency: string; outcome: CallOutcome; probeToken: string | null }[] = [];
  const asked: string[] = [];
  let broken = false;
  const guard: PollDeps["guard"] = {
    isOn: async (subsystem) => {
      if (broken) throw new Error("database down");
      return !off.has(subsystem);
    },
    acquire: async (dependency) => {
      if (broken) throw new Error("database down");
      asked.push(dependency);
      return decisions.get(dependency) ?? { allowed: true, probe: false };
    },
    report: async (dependency, outcome, probeToken) => {
      reports.push({ dependency, outcome, probeToken });
    },
  };
  return { guard, off, decisions, reports, asked, breakAll: () => (broken = true) };
}

// An in-memory watchlist and job store: what packages/db does, without a database.
function world(pages: Record<string, Page>, watches: Watch[]) {
  const web = fakeWeb(pages);
  const jobs: DedupeCandidate[] = [];
  const recorded: { watchId: string; result: PollResult; next: NextState }[] = [];
  const g = fakeGuard();
  const deps: PollDeps = {
    ...web.deps,
    guard: g.guard,
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
  return { deps, jobs, recorded, pages, asked: web.asked, g };
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

describe("kill switches and breakers (RES-002, RES-008)", () => {
  const two = () => [
    watch({}),
    watch({ id: "w-initech", ats: "lever", board: "initech", tier: 2 }),
  ];

  it("a board whose source switch is off is not fetched or recorded, and other ATSs still poll", async () => {
    const w = world({ [GH]: { body: { jobs: [ghJob(1)] } }, [LEVER]: { body: [] } }, two());
    w.g.off.add("source:greenhouse");
    const summary = await pollDue(w.deps, T0);
    expect(w.asked).toEqual([LEVER]);
    expect(w.recorded.map((r) => r.watchId)).toEqual(["w-initech"]);
    expect(summary.paused).toBe(1);
    expect(w.jobs).toHaveLength(0);
  });

  it("a board whose breaker refuses the call is not fetched or recorded, so it stays due", async () => {
    const w = world({ [GH]: { body: { jobs: [ghJob(1)] } }, [LEVER]: { body: [] } }, two());
    w.g.decisions.set("source:greenhouse", { allowed: false, retryAt: at(1), lastError: "Error" });
    const summary = await pollDue(w.deps, T0);
    expect(w.asked).toEqual([LEVER]);
    expect(w.recorded.map((r) => r.watchId)).toEqual(["w-initech"]);
    expect(summary.paused).toBe(1);
  });

  it("a board read reports success to its ATS's breaker, and a failed read reports its error name", async () => {
    const w = world({ [GH]: { status: 503, body: "busy" }, [LEVER]: { body: [] } }, two());
    await pollDue(w.deps, T0);
    expect(w.g.reports).toEqual([
      {
        dependency: "source:greenhouse",
        outcome: { ok: false, error: "BoardUnavailable" },
        probeToken: null,
      },
      { dependency: "source:lever", outcome: { ok: true }, probeToken: null },
    ]);
  });

  it("postings that fail to save don't count against the ATS: the read reports success", async () => {
    const w = world({ [GH]: { body: { jobs: [ghJob(1)] } } }, [watch({})]);
    w.deps.store.save = async () => {
      throw new Error("database down");
    };
    await pollDue(w.deps, T0);
    expect(w.recorded[0]?.result.outcome).toBe("failed");
    expect(w.g.reports).toEqual([
      { dependency: "source:greenhouse", outcome: { ok: true }, probeToken: null },
    ]);
  });

  it("a probe passes its token back with the outcome", async () => {
    const w = world({ [GH]: { body: { jobs: [] } } }, [watch({})]);
    w.g.decisions.set("source:greenhouse", { allowed: true, probe: true, probeToken: "tok-1" });
    await pollDue(w.deps, T0);
    expect(w.g.reports).toEqual([
      { dependency: "source:greenhouse", outcome: { ok: true }, probeToken: "tok-1" },
    ]);
  });

  it("when the switch or breaker can't be checked, no board is read (fail safe)", async () => {
    const w = world({ [GH]: { body: { jobs: [ghJob(1)] } }, [LEVER]: { body: [] } }, two());
    w.g.breakAll();
    const summary = await pollDue(w.deps, T0);
    expect(w.asked).toEqual([]);
    expect(w.recorded).toEqual([]);
    expect(summary).toEqual({ boards: 2, added: 0, failed: 0, quarantined: 0, paused: 2 });
  });

  it("a breaker report that throws still records the board's result", async () => {
    const w = world({ [GH]: { body: { jobs: [ghJob(1)] } } }, [watch({})]);
    w.deps.guard.report = async () => {
      throw new Error("database down");
    };
    await pollDue(w.deps, T0);
    expect(w.recorded.map((r) => r.result.outcome)).toEqual(["ok"]);
    expect(w.jobs).toHaveLength(1);
  });

  // NS-260: Workday boards are read now, behind the same switch and breaker as the others.
  it("a Workday watch is read behind source:workday's switch and breaker", async () => {
    const wd = "https://initech.wd5.myworkdayjobs.com/wday/cxs/initech/Careers/jobs";
    const w = world(
      {
        [wd]: {
          body: {
            jobPostings: [{ title: "Engineer", externalPath: "/job/Remote/Engineer_R-1001" }],
          },
        },
      },
      [watch({ ats: "workday", board: "initech.wd5/Careers" })],
    );
    await pollDue(w.deps, T0);
    expect([w.g.reports.map((r) => r.dependency), w.recorded.map((r) => r.result.outcome)]).toEqual(
      [["source:workday"], ["ok"]],
    );
    expect(w.jobs).toHaveLength(1);
  });
});

describe("pollDue for the HN Who is hiring? thread (NS-282)", () => {
  const SEARCH =
    "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=20";
  const ITEM = "https://hn.algolia.com/api/v1/items/900000002";
  const pages = {
    [SEARCH]: {
      body: {
        hits: [
          {
            objectID: "900000002",
            title: "Ask HN: Who is hiring? (December 2025)",
            created_at_i: 1,
          },
        ],
      },
    },
    [ITEM]: {
      body: {
        id: 900000002,
        children: [
          { id: 1001, type: "comment", author: "a", text: "Globex | Backend Engineer | Remote" },
          { id: 1003, type: "comment", author: "b", text: "Initech | Data Scientist | Austin, TX" },
        ],
      },
    },
  };
  const hn = () =>
    watch({
      id: "w-hn",
      ats: "hn_hiring",
      board: "whoishiring",
      url: "https://news.ycombinator.com/submitted?id=whoishiring",
    });

  it("saves each posting behind source:hn_hiring's switch and breaker, with no ATS", async () => {
    const w = world(pages, [hn()]);
    await pollDue(w.deps, T0);
    expect([w.g.reports.map((r) => r.dependency), w.recorded.map((r) => r.result.outcome)]).toEqual(
      [["source:hn_hiring"], ["ok"]],
    );
    expect(w.jobs.map((j) => [j.company, j.title, j.sources[0]?.ats])).toEqual([
      ["Globex", "Backend Engineer", null],
      ["Initech", "Data Scientist", null],
    ]);
  });

  it("polling the thread twice adds nothing the second time", async () => {
    const w = world(pages, [hn()]);
    await pollDue(w.deps, T0);
    w.recorded.length = 0;
    await pollDue(w.deps, at(120));
    expect([w.jobs.length, w.recorded[0]?.result.added]).toEqual([2, 0]);
  });

  it("merges a posting into the saved job it duplicates (SRC-006) instead of adding it", async () => {
    const w = world(pages, [hn()]);
    w.jobs.push({
      jobId: "job-saved",
      company: "Globex",
      title: "Backend Engineer",
      location: "Remote",
      description: "Globex | Backend Engineer | Remote",
      sources: [
        { url: "https://boards.greenhouse.io/globex/jobs/1", ats: "greenhouse", atsPostingId: "1" },
      ],
    });
    await pollDue(w.deps, T0);
    expect(w.jobs.find((j) => j.jobId === "job-saved")?.sources.map((src) => src.url)).toEqual([
      "https://boards.greenhouse.io/globex/jobs/1",
      "https://news.ycombinator.com/item?id=1001",
    ]);
    expect(w.jobs).toHaveLength(2);
  });

  it("isn't fetched while source:hn_hiring is switched off", async () => {
    const w = world(pages, [hn()]);
    w.g.off.add("source:hn_hiring");
    await pollDue(w.deps, T0);
    expect([w.asked, w.jobs]).toEqual([[], []]);
  });
});

describe("pollDue for an RSS, Atom or JSON Feed (NS-282 slice 2)", () => {
  const FEED = "https://jobs.example.com/feed.xml";
  const pages = {
    [FEED]: {
      contentType: "application/rss+xml",
      body: `<rss version="2.0"><channel><title>Jobs</title>
        <item><title>Globex: Backend Engineer</title><link>https://jobs.example.com/p/1</link></item>
        <item><title>We're hiring</title><link>https://jobs.example.com/p/2</link></item>
      </channel></rss>`,
    },
  };
  const feed = () => watch({ id: "w-feed", ats: "feed", board: FEED, url: FEED });

  it("saves each item behind source:feed's switch and breaker, with no ATS", async () => {
    const w = world(pages, [feed()]);
    await pollDue(w.deps, T0);
    expect([w.g.reports.map((r) => r.dependency), w.recorded.map((r) => r.result.outcome)]).toEqual(
      [["source:feed"], ["ok"]],
    );
    expect(w.jobs.map((j) => [j.company, j.title, j.sources[0]?.ats])).toEqual([
      ["Globex", "Backend Engineer", null],
      [null, null, null],
    ]);
  });

  it("polling the feed twice adds nothing the second time", async () => {
    const w = world(pages, [feed()]);
    await pollDue(w.deps, T0);
    w.recorded.length = 0;
    await pollDue(w.deps, at(120));
    expect([w.jobs.length, w.recorded[0]?.result.added]).toEqual([2, 0]);
  });

  it("isn't fetched while source:feed is switched off", async () => {
    const w = world(pages, [feed()]);
    w.g.off.add("source:feed");
    await pollDue(w.deps, T0);
    expect([w.asked, w.jobs]).toEqual([[], []]);
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

  it("a board held back by its switch leaves a source.poll.paused span saying so, and no source.poll span", async () => {
    const w = world({ [GH]: { body: { jobs: [] } } }, [watch({ id: WATCH_UUID })]);
    w.g.off.add("source:greenhouse");
    await pollDue(w.deps, T0);
    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name)).toEqual(["source.poll.paused"]);
    expect(spans[0]?.attributes).toEqual({
      "source.ats": "greenhouse",
      "source.watch_id": WATCH_UUID,
      "source.paused_by": "kill_switch",
    });
  });

  it("a board refused by its breaker is paused_by breaker", async () => {
    const w = world({ [GH]: { body: { jobs: [] } } }, [watch({})]);
    w.g.decisions.set("source:greenhouse", { allowed: false, retryAt: at(1), lastError: null });
    await pollDue(w.deps, T0);
    const span = exporter.getFinishedSpans().find((s) => s.name === "source.poll.paused");
    expect(span?.attributes["source.paused_by"]).toBe("breaker");
  });

  it("a guard that throws is paused_by guard_error with the error's name, never its message", async () => {
    const w = world({ [GH]: { body: { jobs: [] } } }, [watch({})]);
    w.g.breakAll();
    await pollDue(w.deps, T0);
    const span = exporter.getFinishedSpans().find((s) => s.name === "source.poll.paused");
    expect(span?.attributes["source.paused_by"]).toBe("guard_error");
    expect(span?.attributes["source.guard_error"]).toBe("Error");
    expect(JSON.stringify(span?.attributes)).not.toContain("database down");
  });

  it("a breaker report that throws marks the source.poll span", async () => {
    const w = world({ [GH]: { body: { jobs: [] } } }, [watch({})]);
    w.deps.guard.report = async () => {
      throw new Error("database down");
    };
    await pollDue(w.deps, T0);
    const span = exporter.getFinishedSpans().find((s) => s.name === "source.poll");
    expect(span?.attributes["source.breaker_report_failed"]).toBe(true);
  });
});
