import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { budgetHold, loadLlmBudget, type SpendMeter, type Spent } from "./budget.js";
import { createLlmGateway } from "./gateway.js";
import { describeHeldBack, HeldBack } from "./guard.js";
import { fakeClient } from "./test/fake-client.js";
import { fakeGuard } from "./test/fake-guard.js";
import { okMessage } from "./test/responses.js";
import { testRoute } from "./test/test-route.js";

// The LLM spend cap (NS-176 slice 2, RES-009, ADR-0021). Fakes only; no network.

const exporter = new InMemorySpanExporter();
beforeAll(() => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});
afterAll(() => {
  trace.disable();
});
beforeEach(() => {
  exporter.reset();
});
const spanAttrs = () => exporter.getFinishedSpans().find((s) => s.name === "llm.call")?.attributes;

const CAPS = { dailyUsd: 10, monthlyUsd: null };
const spent = (todayUsd: number, monthUsd = 0): Spent => ({ todayUsd, monthUsd });

describe("budgetHold", () => {
  it("holds low back at 80 %, normal at 100 % and fresh at 125 % of a cap", () => {
    const at = (usd: number) =>
      (["low", "normal", "fresh"] as const).map((p) => budgetHold(spent(usd), CAPS, p));
    expect([at(7.99), at(8), at(10), at(12.5)]).toEqual([
      [null, null, null],
      ["daily", null, null],
      ["daily", "daily", null],
      ["daily", "daily", "daily"],
    ]);
  });

  it("holds back on the monthly cap too", () => {
    expect(budgetHold(spent(0, 100), { dailyUsd: null, monthlyUsd: 100 }, "normal")).toBe(
      "monthly",
    );
  });

  it("holds nothing back with no cap set", () => {
    expect(budgetHold(spent(1e6, 1e6), { dailyUsd: null, monthlyUsd: null }, "low")).toBe(null);
  });
});

describe("loadLlmBudget", () => {
  it("reads both caps, and an unset or empty one as no cap", () => {
    expect([
      loadLlmBudget({ LLM_DAILY_CAP_USD: "5", LLM_MONTHLY_CAP_USD: "120.50" }),
      loadLlmBudget({ LLM_DAILY_CAP_USD: "" }),
    ]).toEqual([
      { dailyUsd: 5, monthlyUsd: 120.5 },
      { dailyUsd: null, monthlyUsd: null },
    ]);
  });

  it("names a bad setting, never its value", () => {
    expect(() => loadLlmBudget({ LLM_DAILY_CAP_USD: "-3", LLM_MONTHLY_CAP_USD: "lots" })).toThrow(
      "LLM_DAILY_CAP_USD, LLM_MONTHLY_CAP_USD: a positive amount of US dollars, like 5 or 12.50",
    );
  });
});

function meter(now: Spent, fail: "spent" | "record" | null = null) {
  const recorded: [string, number][] = [];
  const m: SpendMeter = {
    spent: async () => {
      if (fail === "spent") throw new Error("database down");
      return now;
    },
    record: async (route, usd) => {
      if (fail === "record") throw new Error("database down");
      recorded.push([route, usd]);
    },
  };
  return { m, recorded };
}

const INPUT = { jobText: "Fully remote backend role at Example Corp." };

describe("the gateway with a budget", () => {
  it("records each reply's cost under the route's name", async () => {
    const { m, recorded } = meter(spent(0));
    const gateway = createLlmGateway({
      client: fakeClient([okMessage()]),
      now: () => 0,
      budget: { caps: CAPS, meter: m },
    });
    await gateway.call(testRoute, INPUT);
    expect(recorded.map(([route, usd]) => [route, usd > 0])).toEqual([["test-classify", true]]);
  });

  it("holds a normal route back at the cap without calling the model or the breaker", async () => {
    const client = fakeClient([okMessage()]);
    const guard = fakeGuard();
    const { m } = meter(spent(10));
    const gateway = createLlmGateway({
      client,
      now: () => 0,
      guard,
      budget: { caps: CAPS, meter: m },
    });
    const error = await gateway.call(testRoute, INPUT).catch((e: unknown) => e);
    expect([
      error instanceof HeldBack && [error.by, error.what, error.retryable],
      client.requests.length,
      guard.log,
    ]).toEqual([["budget", "daily", true], 0, []]);
  });

  it("lets a fresh route run past the cap", async () => {
    const { m } = meter(spent(11));
    const gateway = createLlmGateway({
      client: fakeClient([okMessage()]),
      now: () => 0,
      budget: { caps: CAPS, meter: m },
    });
    const outcome = await gateway.call({ ...testRoute, priority: "fresh" }, INPUT);
    expect(outcome.kind).toBe("Ok");
  });

  it("holds the call back when the meter can't be read", async () => {
    const client = fakeClient([okMessage()]);
    const { m } = meter(spent(0), "spent");
    const gateway = createLlmGateway({ client, now: () => 0, budget: { caps: CAPS, meter: m } });
    const error = await gateway.call(testRoute, INPUT).catch((e: unknown) => e);
    expect([error instanceof HeldBack && error.by, client.requests.length]).toEqual(["budget", 0]);
  });

  it("still returns the reply when recording its cost fails", async () => {
    const { m } = meter(spent(0), "record");
    const gateway = createLlmGateway({
      client: fakeClient([okMessage()]),
      now: () => 0,
      budget: { caps: CAPS, meter: m },
    });
    expect((await gateway.call(testRoute, INPUT)).kind).toBe("Ok");
  });

  it("holds a low route back at 80 % and a fresh one at 125 %, through the gateway", async () => {
    const run = async (usd: number, priority: "low" | "fresh") => {
      const { m } = meter(spent(usd));
      const gateway = createLlmGateway({
        client: fakeClient([okMessage()]),
        now: () => 0,
        budget: { caps: CAPS, meter: m },
      });
      return gateway.call({ ...testRoute, priority }, INPUT).then(
        (o) => o.kind,
        (e: unknown) => (e instanceof HeldBack ? e.by : "error"),
      );
    };
    expect([
      await run(7.9, "low"),
      await run(8, "low"),
      await run(12.4, "fresh"),
      await run(12.5, "fresh"),
    ]).toEqual(["Ok", "budget", "Ok", "budget"]);
  });

  it("marks a held call's span with the hold and the route's priority", async () => {
    const { m } = meter(spent(10));
    const gateway = createLlmGateway({
      client: fakeClient([okMessage()]),
      now: () => 0,
      budget: { caps: CAPS, meter: m },
    });
    await gateway.call(testRoute, INPUT).catch(() => undefined);
    const attrs = spanAttrs();
    expect([attrs?.["northstar.llm.held_by"], attrs?.["northstar.llm.priority"]]).toEqual([
      "budget",
      "normal",
    ]);
  });

  it("marks the span when a cost couldn't be recorded, and when the reply was unpriced", async () => {
    const { m } = meter(spent(0), "record");
    const gateway = createLlmGateway({
      client: fakeClient([okMessage({ model: "claude-unknown-9" })]),
      now: () => 0,
      budget: { caps: CAPS, meter: m },
    });
    await gateway.call(testRoute, INPUT);
    const attrs = spanAttrs();
    expect([
      attrs?.["northstar.llm.spend_record_failed"],
      attrs?.["northstar.llm.unpriced"],
    ]).toEqual([true, true]);
  });

  it("reads no spend and holds nothing back when no cap is set, but still records", async () => {
    const { m, recorded } = meter(spent(0), "spent");
    const gateway = createLlmGateway({
      client: fakeClient([okMessage()]),
      now: () => 0,
      budget: { caps: { dailyUsd: null, monthlyUsd: null }, meter: m },
    });
    expect([(await gateway.call(testRoute, INPUT)).kind, recorded.length]).toEqual(["Ok", 1]);
  });

  it("says plainly which cap held a route back, or that spend couldn't be read or recorded", () => {
    expect([
      describeHeldBack(new HeldBack("budget", "daily")),
      describeHeldBack(new HeldBack("budget", "unknown")),
      describeHeldBack(new HeldBack("budget", "unrecorded")),
    ]).toEqual([
      "the daily LLM spend cap is reached for this route",
      "LLM spend couldn't be read (is the database up?)",
      "earlier LLM spend couldn't be recorded (is the database up?)",
    ]);
  });
});
