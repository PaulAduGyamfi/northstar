import type { JobListItem, Watch } from "@northstar/db";
import { describe, expect, it } from "vitest";
import { type CliDeps, main } from "./cli.js";
import { noFit } from "./fit/test/fake-fit.js";
import { freshness, queueScore } from "./queue.js";
import type { BoardCliDeps } from "./watch-cli.js";

// Synthetic boards and jobs only (invented companies).
const NOW = new Date("2026-11-25T12:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

const globex: Watch = {
  id: "w1",
  ats: "greenhouse",
  board: "globex",
  url: "https://boards.greenhouse.io/globex",
  tier: 1,
  status: "ok",
  nextPollAt: NOW,
  lastPolledAt: ago(5),
  lastSuccessAt: ago(5),
  consecutiveFailures: 0,
  lastError: null,
  jobsFound: 4,
};

function deps(argv: string[], over: Partial<BoardCliDeps> = {}, jobs: JobListItem[] = []) {
  const printed: string[] = [];
  const calls: unknown[] = [];
  const boards: BoardCliDeps = {
    add: async (target, tier) => {
      calls.push(["add", target, tier]);
      return { status: "added", id: "w1" };
    },
    list: async () => [globex],
    remove: async (id) => id === "w1",
    retry: async (id) => id === "w1",
    poll: async () => ({ boards: 2, added: 3, failed: 1, quarantined: 0 }),
    wait: async () => false,
    ...over,
  };
  const d: CliDeps = {
    argv,
    print: (l) => printed.push(l),
    now: () => NOW,
    addUrl: async () => ({ status: "refused", reason: "x" }),
    addText: async () => ({ status: "refused", reason: "x" }),
    readText: async () => "",
    list: async () => jobs,
    set: async () => ({ ok: true, value: { status: "ready", missingFields: [] } }),
    boards,
    check: async () => ({
      checked: 0,
      open: 0,
      closed: 0,
      unavailable: 0,
      heldBack: 0,
      unchecked: 0,
    }),
    fit: noFit(),
  };
  return { d, printed, calls };
}

describe("jobs watch", () => {
  it("adds a board with its parsed ATS, id and tier", async () => {
    const { d, printed, calls } = deps([
      "watch",
      "add",
      "https://jobs.lever.co/initech",
      "--tier",
      "2",
    ]);
    expect(await main(d)).toBe(0);
    expect(calls).toEqual([
      ["add", { ats: "lever", board: "initech", url: "https://jobs.lever.co/initech" }, 2],
    ]);
    expect(printed).toEqual([
      "Watching lever board initech (tier 2, every 20 min). First poll on the next jobs poll or jobs run.",
    ]);
  });

  it("refuses a link that isn't a supported board, saying which boards are", async () => {
    const { d, printed, calls } = deps([
      "watch",
      "add",
      "https://boards.greenhouse.io/globex/jobs/1",
      "--tier",
      "1",
    ]);
    expect(await main(d)).toBe(1);
    expect(calls).toEqual([]);
    expect(printed[0]).toContain("isn't a job board link");
  });

  it("refuses a tier other than 1, 2 or 3", async () => {
    const { d, calls } = deps(["watch", "add", "https://jobs.lever.co/initech", "--tier", "4"]);
    expect(await main(d)).toBe(1);
    expect(calls).toEqual([]);
  });

  it("lists each board with its tier, status, last success and jobs found", async () => {
    const { d, printed } = deps(["watch", "list"]);
    expect(await main(d)).toBe(0);
    expect(printed).toEqual([
      "w1  greenhouse/globex · tier 1 · ok · last read 5 min ago · 4 jobs found",
    ]);
  });

  it("shows a quarantined board's error and how to retry it", async () => {
    const { d, printed } = deps(["watch", "list"], {
      list: async () => [
        { ...globex, status: "quarantined", consecutiveFailures: 5, lastError: "BoardUnavailable" },
      ],
    });
    await main(d);
    expect(printed[0]).toContain(
      "quarantined after 5 failures (BoardUnavailable): jobs watch retry w1",
    );
  });

  it("removes and retries by id, and says when there is no such board", async () => {
    expect(await main(deps(["watch", "remove", "w1"]).d)).toBe(0);
    expect(await main(deps(["watch", "retry", "w1"]).d)).toBe(0);
    const missing = deps(["watch", "remove", "nope"]);
    expect(await main(missing.d)).toBe(1);
    expect(missing.printed).toEqual(["No watched board nope."]);
  });
});

describe("jobs poll and jobs run", () => {
  it("poll runs one pass and prints its counts", async () => {
    const { d, printed } = deps(["poll"]);
    expect(await main(d)).toBe(0);
    expect(printed).toEqual(["Polled 2 boards: 3 new jobs, 1 failed."]);
  });

  it("poll says how many boards a kill switch or an open breaker held back", async () => {
    const { d, printed } = deps(["poll"], {
      poll: async () => ({ boards: 3, added: 1, failed: 0, quarantined: 0, paused: 2 }),
    });
    expect(await main(d)).toBe(0);
    expect(printed).toEqual([
      "Polled 3 boards: 1 new job, 2 paused (switched off, ATS breaker open or not checkable).",
    ]);
  });

  it("run polls once a minute until stopped", async () => {
    let ticks = 0;
    const waits: number[] = [];
    const { d } = deps(["run"], {
      poll: async () => {
        ticks++;
        return { boards: 0, added: 0, failed: 0, quarantined: 0 };
      },
      wait: async (ms) => {
        waits.push(ms);
        return waits.length < 3;
      },
    });
    expect(await main(d)).toBe(0);
    expect(ticks).toBe(3);
    expect(waits).toEqual([60_000, 60_000, 60_000]);
  });

  it("run keeps going when one pass fails (the database was down, say)", async () => {
    let ticks = 0;
    const { d, printed } = deps(["run"], {
      poll: async () => {
        ticks++;
        if (ticks === 1) throw Object.assign(new Error("connect ECONNREFUSED"), { name: "DbDown" });
        return { boards: 1, added: 1, failed: 0, quarantined: 0 };
      },
      wait: async () => ticks < 2,
    });
    expect(await main(d)).toBe(0);
    expect(ticks).toBe(2);
    expect(printed.some((l) => l.includes("pass failed (DbDown)"))).toBe(true);
    expect(printed.join("\n")).not.toContain("ECONNREFUSED");
  });
});

describe("fresh-first order (SRC-013)", () => {
  it("a 20-minute-old job outranks a 5-day-old one", () => {
    expect(freshness(20 / 60)).toBeGreaterThan(freshness(5 * 24));
    expect(queueScore(freshness(20 / 60), null)).toBeCloseTo(0.99, 2);
  });

  it("jobs list puts the freshest job first, whatever order the store returns", async () => {
    const job = (id: string, postedMinAgo: number): JobListItem => ({
      id,
      status: "ready",
      title: `Role ${id}`,
      company: "Globex",
      location: "Remote",
      postedAt: ago(postedMinAgo),
      firstSeenAt: ago(1),
      sources: 1,
      missingFields: [],
      fit: null,
    });
    const { d, printed } = deps(["list"], {}, [job("old", 5 * 24 * 60), job("new", 20)]);
    await main(d);
    expect(printed.map((l) => l.split(" ")[0])).toEqual(["new", "old"]);
  });
});
