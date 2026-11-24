import { APIConnectionTimeoutError, APIError } from "@anthropic-ai/sdk";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LlmTransportError } from "./errors.js";
import { createLlmGateway } from "./gateway.js";
import type { BetaMessage } from "./sdk-types.js";
import { fakeClient } from "./test/fake-client.js";
import { fallbackMessage, okMessage, refusalMessage, truncatedMessage } from "./test/responses.js";
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

const JOB_TEXT = "Fully remote backend role at Example Corp.";

// A clock that reads 1000 ms at the start of a call and 1450 ms at the end.
const clock = () => {
  const ticks = [1000, 1450];
  return () => ticks.shift() ?? 9999;
};

const gatewayAnswering = (answer: BetaMessage | Error) =>
  createLlmGateway({ client: fakeClient([answer]), now: clock() });

// The record every outcome carries, for the default synthetic usage on Opus 5.5.
const baseRecord = {
  route: "test-classify",
  promptId: "test-classify",
  promptVersion: 1,
  modelRequested: "claude-opus-5-5",
  modelServed: "claude-opus-5-5",
  effort: "low",
  inputTokens: 1200,
  outputTokens: 300,
  cacheReadTokens: 4000,
  cacheWriteTokens: 0,
  latencyMs: 450,
  // 1200 × $4 + 300 × $20 + 4000 × $0.20 per million tokens
  costUsd: 0.0116,
  stopReason: "end_turn",
  refusalCategory: null,
  fallbackUsed: false,
};

describe("llm gateway", () => {
  it("returns the parsed output and an exact call record for a valid reply", async () => {
    const outcome = await gatewayAnswering(okMessage()).call(testRoute, { jobText: JOB_TEXT });
    expect(outcome).toEqual({
      kind: "Ok",
      output: { label: "remote", confidence: 0.9 },
      record: baseRecord,
    });
  });

  it("returns Refused with the category and never reads the content", async () => {
    const outcome = await gatewayAnswering(refusalMessage()).call(testRoute, {
      jobText: JOB_TEXT,
    });
    expect(outcome).toEqual({
      kind: "Refused",
      category: "cyber",
      record: { ...baseRecord, stopReason: "refusal", refusalCategory: "cyber" },
    });
  });

  it("returns Truncated when the reply hit max_tokens", async () => {
    const outcome = await gatewayAnswering(truncatedMessage()).call(testRoute, {
      jobText: JOB_TEXT,
    });
    expect(outcome).toEqual({
      kind: "Truncated",
      record: { ...baseRecord, stopReason: "max_tokens" },
    });
  });

  it("returns InvalidOutput with field paths and no values when the JSON breaks the schema", async () => {
    const bad = okMessage({
      content: [{ type: "text", text: '{"label":"hybrid","confidence":0.4}', citations: null }],
    } as Partial<BetaMessage>);
    const outcome = await gatewayAnswering(bad).call(testRoute, { jobText: JOB_TEXT });
    expect(outcome).toEqual({
      kind: "InvalidOutput",
      reason: "schema",
      fields: ["label"],
      record: baseRecord,
    });
    expect(JSON.stringify(outcome)).not.toContain("hybrid");
  });

  it("returns InvalidOutput when the reply is not JSON", async () => {
    const bad = okMessage({
      content: [{ type: "text", text: "remote, probably", citations: null }],
    } as Partial<BetaMessage>);
    const outcome = await gatewayAnswering(bad).call(testRoute, { jobText: JOB_TEXT });
    expect(outcome).toMatchObject({ kind: "InvalidOutput", reason: "not_json", fields: [] });
  });

  it("returns InvalidOutput for a stop reason the gateway does not expect", async () => {
    const odd = okMessage({ stop_reason: "pause_turn" } as Partial<BetaMessage>);
    const outcome = await gatewayAnswering(odd).call(testRoute, { jobText: JOB_TEXT });
    expect(outcome).toMatchObject({ kind: "InvalidOutput", reason: "stop_reason", fields: [] });
  });

  it("records the fallback model that served the reply and prices it at that model's rates", async () => {
    const outcome = await gatewayAnswering(fallbackMessage()).call(testRoute, {
      jobText: JOB_TEXT,
    });
    expect(outcome.record).toEqual({
      ...baseRecord,
      modelServed: "claude-sonnet-5-5",
      fallbackUsed: true,
      // 1200 × $2 + 300 × $10 + 4000 × $0.10 per million tokens
      costUsd: 0.0058,
    });
  });

  it("records costUsd as null when the served model has no known price", async () => {
    const outcome = await gatewayAnswering(
      okMessage({ model: "claude-unknown-9" } as Partial<BetaMessage>),
    ).call(testRoute, { jobText: JOB_TEXT });
    expect(outcome.record.costUsd).toBeNull();
    expect(outcome.record.modelServed).toBe("claude-unknown-9");
  });

  it("throws a retryable LlmTransportError for a rate limit", async () => {
    const rateLimited = APIError.generate(429, {}, "rate limited", new Headers());
    const call = gatewayAnswering(rateLimited).call(testRoute, { jobText: JOB_TEXT });
    await expect(call).rejects.toEqual(new LlmTransportError({ status: 429, retryable: true }));
  });

  it("throws a retryable LlmTransportError for a server error and a timeout", async () => {
    const overloaded = APIError.generate(529, {}, "overloaded", new Headers());
    await expect(
      gatewayAnswering(overloaded).call(testRoute, { jobText: JOB_TEXT }),
    ).rejects.toEqual(new LlmTransportError({ status: 529, retryable: true }));
    await expect(
      gatewayAnswering(new APIConnectionTimeoutError()).call(testRoute, { jobText: JOB_TEXT }),
    ).rejects.toEqual(new LlmTransportError({ status: null, retryable: true }));
  });

  it("throws a non-retryable LlmTransportError for a bad request", async () => {
    const badRequest = APIError.generate(400, {}, "bad request", new Headers());
    const call = gatewayAnswering(badRequest).call(testRoute, { jobText: JOB_TEXT });
    await expect(call).rejects.toEqual(new LlmTransportError({ status: 400, retryable: false }));
  });

  it("opens an llm.call span with the call record and no prompt or reply text", async () => {
    await gatewayAnswering(okMessage()).call(testRoute, { jobText: JOB_TEXT });
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("llm.call");
    expect(span?.attributes).toEqual({
      "northstar.llm.route": "test-classify",
      "northstar.llm.prompt_id": "test-classify",
      "northstar.llm.prompt_version": 1,
      "northstar.llm.model.requested": "claude-opus-5-5",
      "northstar.llm.model.served": "claude-opus-5-5",
      "northstar.llm.effort": "low",
      "northstar.llm.tokens.input": 1200,
      "northstar.llm.tokens.output": 300,
      "northstar.llm.tokens.cache_read": 4000,
      "northstar.llm.tokens.cache_write": 0,
      "northstar.llm.latency_ms": 450,
      "northstar.llm.cost_usd": 0.0116,
      "northstar.llm.stop_reason": "end_turn",
      "northstar.llm.fallback_used": false,
      "northstar.llm.outcome": "Ok",
    });
    const everything = JSON.stringify(span?.attributes);
    expect(everything).not.toContain("Example Corp");
    expect(everything).not.toContain("remote role");
  });

  it("marks the span as an error with the error kind when the transport fails", async () => {
    const rateLimited = APIError.generate(429, {}, "rate limited", new Headers());
    await gatewayAnswering(rateLimited)
      .call(testRoute, { jobText: JOB_TEXT })
      .catch(() => undefined);
    const [span] = exporter.getFinishedSpans();
    expect(span?.status).toEqual({ code: SpanStatusCode.ERROR, message: "LlmTransportError" });
    expect(span?.attributes["northstar.llm.outcome"]).toBe("TransportError");
  });

  it("labels a non-transport failure as Error, not TransportError, and rethrows it", async () => {
    const call = gatewayAnswering(new Error("bug")).call(testRoute, { jobText: JOB_TEXT });
    await expect(call).rejects.toThrow("bug");
    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes["northstar.llm.outcome"]).toBe("Error");
    expect(span?.status).toEqual({ code: SpanStatusCode.ERROR, message: "Error" });
  });

  it("sends the request built for the route, with its timeout", async () => {
    const client = fakeClient([okMessage()]);
    await createLlmGateway({ client, now: clock() }).call(testRoute, { jobText: JOB_TEXT });
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]?.options).toEqual({ timeout: 30_000 });
    expect(client.requests[0]?.params.output_config?.effort).toBe("low");
  });
});
