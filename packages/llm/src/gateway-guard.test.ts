import { APIConnectionTimeoutError, APIError } from "@anthropic-ai/sdk";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLlmGateway } from "./gateway.js";
import { describeHeldBack, HeldBack } from "./guard.js";
import type { BetaMessage } from "./sdk-types.js";
import { fakeClient } from "./test/fake-client.js";
import { fakeGuard } from "./test/fake-guard.js";
import { okMessage, refusalMessage, truncatedMessage } from "./test/responses.js";
import { testRoute } from "./test/test-route.js";

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

const INPUT = { jobText: "Fully remote backend role at Example Corp." };
const RETRY_AT = new Date("2026-11-25T22:30:00Z");

function setup(answer: BetaMessage | Error, guard = fakeGuard()) {
  const client = fakeClient([answer]);
  const gateway = createLlmGateway({ client, now: () => 0, guard });
  return { client, guard, gateway };
}

const spanAttrs = () => exporter.getFinishedSpans().find((s) => s.name === "llm.call")?.attributes;

describe("llm gateway with a guard", () => {
  it("checks the route's switch, then the anthropic breaker, then calls and reports", async () => {
    const { guard, gateway } = setup(okMessage());
    const outcome = await gateway.call(testRoute, INPUT);
    expect(outcome.kind).toBe("Ok");
    expect(guard.log).toEqual([
      "isOn agent:test-classify",
      "acquire anthropic",
      "report anthropic",
    ]);
    expect(guard.reports).toEqual([
      { dependency: "anthropic", outcome: { ok: true }, probeToken: null },
    ]);
  });

  it("holds a route back without calling the model while its switch is off", async () => {
    const { client, guard, gateway } = setup(
      okMessage(),
      fakeGuard({ off: ["agent:test-classify"] }),
    );
    const error = await gateway.call(testRoute, INPUT).catch((e: unknown) => e);
    expect(error).toEqual(new HeldBack("kill_switch", "agent:test-classify"));
    expect((error as HeldBack).retryable).toBe(true);
    expect(client.requests).toEqual([]);
    expect(guard.log).toEqual(["isOn agent:test-classify"]);
    expect(spanAttrs()?.["northstar.llm.outcome"]).toBe("HeldBack");
    expect(spanAttrs()?.["northstar.llm.held_by"]).toBe("kill_switch");
  });

  it("holds a call back with the breaker's retry time while the breaker is open", async () => {
    const guard = fakeGuard({
      decisions: {
        anthropic: { allowed: false, retryAt: RETRY_AT, lastError: "LlmTransportError" },
      },
    });
    const { client, gateway } = setup(okMessage(), guard);
    const error = await gateway.call(testRoute, INPUT).catch((e: unknown) => e);
    expect(error).toEqual(new HeldBack("breaker", "anthropic", RETRY_AT));
    expect((error as HeldBack).retryAt).toEqual(RETRY_AT);
    expect(client.requests).toEqual([]);
    expect(guard.reports).toEqual([]);
  });

  it("holds a call back when a guard check throws, naming the error but not its message", async () => {
    for (const throwOn of ["isOn", "acquire"] as const) {
      exporter.reset();
      const { client, gateway } = setup(okMessage(), fakeGuard({ throwOn }));
      const error = await gateway.call(testRoute, INPUT).catch((e: unknown) => e);
      expect(error).toEqual(new HeldBack("guard_error", "anthropic"));
      expect(client.requests).toEqual([]);
      expect(spanAttrs()?.["northstar.llm.guard_error"]).toBe("DbDown");
      expect(JSON.stringify(spanAttrs())).not.toContain("db.internal");
    }
  });

  it("passes a probe's token back with its report", async () => {
    const guard = fakeGuard({
      decisions: {
        anthropic: { allowed: true, probe: true, probeToken: "2026-11-25T22:32:00.000Z" },
      },
    });
    await setup(okMessage(), guard).gateway.call(testRoute, INPUT);
    expect(guard.reports).toEqual([
      { dependency: "anthropic", outcome: { ok: true }, probeToken: "2026-11-25T22:32:00.000Z" },
    ]);
  });

  it("reports a refusal and a truncated reply as the API working", async () => {
    for (const answer of [refusalMessage(), truncatedMessage()]) {
      const { guard, gateway } = setup(answer);
      await gateway.call(testRoute, INPUT);
      expect(guard.reports.map((r) => r.outcome)).toEqual([{ ok: true }]);
    }
  });

  it("reports a rate limit, a server error and a timeout as failures and still throws them", async () => {
    const errors = [
      APIError.generate(429, {}, "rate limited", new Headers()),
      APIError.generate(529, {}, "overloaded", new Headers()),
      new APIConnectionTimeoutError(),
    ];
    for (const answer of errors) {
      const { guard, gateway } = setup(answer);
      await expect(gateway.call(testRoute, INPUT)).rejects.toMatchObject({
        name: "LlmTransportError",
        retryable: true,
      });
      expect(guard.reports.map((r) => r.outcome)).toEqual([
        { ok: false, error: "LlmTransportError" },
      ]);
    }
  });

  it("reports a bad request as the API working, because the fault is the request", async () => {
    const { guard, gateway } = setup(APIError.generate(400, {}, "bad request", new Headers()));
    await expect(gateway.call(testRoute, INPUT)).rejects.toMatchObject({ retryable: false });
    expect(guard.reports.map((r) => r.outcome)).toEqual([{ ok: true }]);
  });

  it("reports nothing for a failure that isn't the API's", async () => {
    const { guard, gateway } = setup(new Error("fakeClient bug"));
    await expect(gateway.call(testRoute, INPUT)).rejects.toThrow("fakeClient bug");
    expect(guard.reports).toEqual([]);
  });

  it("keeps the outcome when the report itself fails, and notes it on the span", async () => {
    const { gateway } = setup(okMessage(), fakeGuard({ throwOn: "report" }));
    const outcome = await gateway.call(testRoute, INPUT);
    expect(outcome.kind).toBe("Ok");
    expect(spanAttrs()?.["northstar.llm.breaker_report_failed"]).toBe(true);
  });
});

describe("describeHeldBack", () => {
  it("names the switch that is off", () => {
    expect(describeHeldBack(new HeldBack("kill_switch", "agent:mail-classify"))).toBe(
      "agent:mail-classify is switched off",
    );
  });

  it("names the open breaker and when it allows the next try", () => {
    expect(describeHeldBack(new HeldBack("breaker", "anthropic", RETRY_AT))).toBe(
      "the anthropic breaker is open until 2026-11-25T22:30:00.000Z",
    );
  });

  it("says the check itself failed when the guard couldn't answer", () => {
    expect(describeHeldBack(new HeldBack("guard_error", "gmail"))).toBe(
      "the switch and breaker check failed for gmail (is the database up?)",
    );
  });
});
