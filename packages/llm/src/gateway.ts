import { type Attributes, SpanStatusCode, trace } from "@opentelemetry/api";
import type { MessagesClient } from "./client.js";
import { LlmTransportError, toTransportError } from "./errors.js";
import { type CallRecord, callRecord, interpretMessage, type LlmOutcome } from "./outcome.js";
import { buildRequest } from "./request.js";
import type { Route } from "./route.js";

export type LlmGateway = {
  call<I, O>(route: Route<I, O>, input: I): Promise<LlmOutcome<O>>;
};

// The one door to the model (ADR-0006). `now` is injected so latency is testable.
export function createLlmGateway(deps: { client: MessagesClient; now: () => number }): LlmGateway {
  const tracer = trace.getTracer("@northstar/llm");

  return {
    call(route, input) {
      return tracer.startActiveSpan("llm.call", async (span) => {
        try {
          const { params, options } = buildRequest(route, input);
          const started = deps.now();
          const message = await deps.client.create(params, options).catch((error: unknown) => {
            throw toTransportError(error);
          });
          const record = callRecord(route, message, deps.now() - started);
          const outcome = interpretMessage(route, message, record);
          span.setAttributes({
            ...recordAttributes(record),
            "northstar.llm.outcome": outcome.kind,
          });
          return outcome;
        } catch (error) {
          // Name the kind only; the error message could quote the request.
          const kind = error instanceof Error ? error.name : "UnknownError";
          span.setAttributes({
            "northstar.llm.route": route.name,
            // TransportError only for API failures; anything else (a bug, a missing fixture)
            // is a plain Error so dashboards don't blame the API for it.
            "northstar.llm.outcome":
              error instanceof LlmTransportError ? "TransportError" : "Error",
          });
          span.setStatus({ code: SpanStatusCode.ERROR, message: kind });
          throw error;
        } finally {
          span.end();
        }
      });
    },
  };
}

// The call record as span attributes. Null values are left out (OpenTelemetry has no null).
function recordAttributes(record: CallRecord): Attributes {
  const attributes: Attributes = {
    "northstar.llm.route": record.route,
    "northstar.llm.prompt_id": record.promptId,
    "northstar.llm.prompt_version": record.promptVersion,
    "northstar.llm.model.requested": record.modelRequested,
    "northstar.llm.model.served": record.modelServed,
    "northstar.llm.effort": record.effort,
    "northstar.llm.tokens.input": record.inputTokens,
    "northstar.llm.tokens.output": record.outputTokens,
    "northstar.llm.tokens.cache_read": record.cacheReadTokens,
    "northstar.llm.tokens.cache_write": record.cacheWriteTokens,
    "northstar.llm.latency_ms": record.latencyMs,
    "northstar.llm.fallback_used": record.fallbackUsed,
  };
  if (record.costUsd !== null) attributes["northstar.llm.cost_usd"] = record.costUsd;
  if (record.stopReason !== null) attributes["northstar.llm.stop_reason"] = record.stopReason;
  if (record.refusalCategory !== null) {
    attributes["northstar.llm.refusal_category"] = record.refusalCategory;
  }
  return attributes;
}
