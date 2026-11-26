import { HeldBack } from "@northstar/llm";
import { describe, expect, it } from "vitest";
import type { FullMessage } from "../gmail.js";
import { createCatcher, type WindowSpec } from "./catcher.js";
import { type PollGmail, pollWindow } from "./poll.js";

// Synthetic tenant and mail only (the repo is public). A fake Gmail and a fake clock: sleeping
// moves the clock, so no test waits.
const T0 = new Date("2026-11-25T12:00:00Z");
const CODE = "482913";
const SPEC: WindowSpec = {
  tenant: "Acme",
  ats: "Workday",
  purpose: "sign_up",
  senderDomains: ["myworkday.com", "acme.example.com"],
  linkHosts: ["acme.wd5.myworkdayjobs.com"],
  ttlMs: 60_000,
};
const AUTH =
  "mx.google.com; dkim=pass header.d=myworkday.com; dmarc=pass header.from=myworkday.com";

function message(
  id: string,
  atMs: number,
  body = `Your verification code is ${CODE}.`,
): FullMessage {
  return {
    id,
    threadId: `t-${id}`,
    from: "Acme Careers <no-reply@myworkday.com>",
    senderDomain: "myworkday.com",
    subject: "Verify your email",
    deliveredTo: "candidate@example.com",
    authenticationResults: AUTH,
    receivedAt: new Date(T0.getTime() + atMs),
    body,
  };
}

// A Gmail whose inbox, on tick n (counting list calls from 1), holds `inbox(n)`; a function
// that throws makes that tick's list call fail.
function setup(inbox: (tick: number) => FullMessage[] | Error) {
  let clock = T0;
  const catcher = createCatcher({ now: () => clock, newId: () => "w-1" });
  const window = catcher.open(SPEC);
  const queries: string[] = [];
  const fetched: string[] = [];
  // The tick (list call count) each fetch happened on.
  const fetchTicks: number[] = [];
  const sleeps: number[] = [];
  let current: FullMessage[] = [];
  const gmail: PollGmail = {
    listIds: async (query) => {
      queries.push(query);
      const got = inbox(queries.length);
      if (got instanceof Error) throw got;
      current = got;
      return got.map((m) => ({ id: m.id, threadId: m.threadId }));
    },
    getFull: async (id) => {
      fetched.push(id);
      fetchTicks.push(queries.length);
      const m = current.find((x) => x.id === id);
      if (!m) throw new Error("not found");
      return m;
    },
  };
  const deps = {
    gmail,
    catcher,
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock = new Date(clock.getTime() + ms);
    },
  };
  return { deps, window, queries, fetched, fetchTicks, sleeps };
}

describe("pollWindow", () => {
  it("finds the code that arrives on the third tick, after three list calls", async () => {
    const { deps, window, queries } = setup((tick) => (tick >= 3 ? [message("m-1", 9_000)] : []));
    const result = await pollWindow(deps, window);
    expect(result.status).toBe("verified");
    if (result.status === "verified") expect(result.secret.reveal()).toBe(CODE);
    expect(queries).toHaveLength(3);
  });

  it("asks Gmail only for the window's sender domains since it opened, less a minute", async () => {
    const { deps, window, queries } = setup(() => [message("m-1", 1_000)]);
    await pollWindow(deps, window);
    // 2026-11-25T12:00:00Z is 1795608000; a minute's slack for clock skew.
    expect(queries).toEqual(["from:(myworkday.com OR acme.example.com) after:1795607940"]);
  });

  it("fetches a message once, however many ticks list it", async () => {
    const welcome = message("m-0", 500, "Welcome to Acme careers!");
    const { deps, window, fetched } = setup((tick) =>
      tick < 3 ? [welcome] : [welcome, message("m-1", 12_000)],
    );
    await pollWindow(deps, window);
    expect(fetched).toEqual(["m-0", "m-1"]);
  });

  it("times out at the window's end without sleeping past it", async () => {
    const { deps, window, sleeps } = setup(() => []);
    const result = await pollWindow(deps, window, { intervalMs: 25_000 });
    expect(result).toEqual({ status: "timed_out", windowId: "w-1", lastError: null });
    // 25 s, 25 s, then only the 10 s left until 12:01:00.
    expect(sleeps).toEqual([25_000, 25_000, 10_000]);
  });

  it("keeps waiting through a failed tick and names the last error on a timeout", async () => {
    const { deps, window, queries } = setup((tick) =>
      tick === 1 ? new HeldBack("breaker", "gmail", new Date(T0.getTime() + 30_000)) : [],
    );
    const result = await pollWindow(deps, window, { intervalMs: 20_000 });
    expect(queries.length).toBeGreaterThan(1);
    expect(result).toEqual({ status: "timed_out", windowId: "w-1", lastError: "HeldBack" });
  });

  it("finds the code after a failed tick", async () => {
    const { deps, window } = setup((tick) =>
      tick === 1 ? new Error("socket hang up") : [message("m-1", 6_000)],
    );
    expect((await pollWindow(deps, window)).status).toBe("verified");
  });

  it("stops with needs_human when the catcher hands the step off", async () => {
    // Two codes and no pick: the catcher can't choose, so Paul gets the step.
    const two = message("m-1", 1_000, "Your code is 482913. Or use 771204.");
    const { deps, window, queries } = setup(() => [two]);
    const result = await pollWindow(deps, window);
    expect(result).toMatchObject({ status: "needs_human", reason: "ambiguous_content" });
    expect(queries).toHaveLength(1);
  });

  it("offers at most ten new messages a tick", async () => {
    const many = Array.from({ length: 12 }, (_, i) => message(`n-${i}`, 500, "Welcome!"));
    const { deps, window, fetched, fetchTicks } = setup(() => many);
    await pollWindow(deps, window, { intervalMs: 30_000 });
    // Ten on the first tick, the last two on the next.
    expect(fetched).toEqual(many.map((m) => m.id));
    expect(fetchTicks).toEqual([...Array(10).fill(1), 2, 2]);
  });
});
