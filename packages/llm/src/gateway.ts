import { type Attributes, SpanStatusCode, trace } from "@opentelemetry/api";
import { budgetHold, type LlmBudget, type SpendMeter } from "./budget.js";
import type { MessagesClient } from "./client.js";
import { LlmTransportError, toTransportError } from "./errors.js";
import { admit, type CallGuard, type GuardOutcome, HeldBack } from "./guard.js";
import { type CallRecord, callRecord, interpretMessage, type LlmOutcome } from "./outcome.js";
import { ceilingCostUsd } from "./pricing.js";
import { buildRequest } from "./request.js";
import type { Route } from "./route.js";

export type LlmGateway = {
  call<I, O>(route: Route<I, O>, input: I): Promise<LlmOutcome<O>>;
};

// The breaker every model call goes through (RES-002).
export const ANTHROPIC_DEPENDENCY = "anthropic";

// The kill switch for one route (RES-008).
export const agentSwitch = (route: string) => `agent:${route}`;

// The one door to the model (ADR-0006). `now` is injected so latency is testable. With a `guard`
// (NS-174), each call first needs its route's `agent:<route>` switch on and the `anthropic`
// breaker's leave, and reports how the API answered. Without one, calls go out unguarded (evals,
// tests).
export function createLlmGateway(deps: {
  client: MessagesClient;
  now: () => number;
  guard?: CallGuard;
  // The spend cap (NS-176, ADR-0021). Without one, spend is neither checked nor recorded.
  budget?: { caps: LlmBudget; meter: SpendMeter };
}): LlmGateway {
  const tracer = trace.getTracer("@northstar/llm");
  const guard = deps.guard;
  const budget = deps.budget;
  // Costs whose record failed, kept until a record succeeds: spend the meter didn't take must
  // still count, or failing writes would switch the cap off (ADR-0021).
  const unrecorded: { route: string; usd: number }[] = [];
  // Tries to record what failed before; true when nothing is left owing.
  const flushUnrecorded = async (meter: SpendMeter): Promise<boolean> => {
    while (unrecorded.length > 0) {
      const next = unrecorded[0];
      if (!next) break;
      try {
        await meter.record(next.route, next.usd);
      } catch {
        return false;
      }
      unrecorded.shift();
    }
    return true;
  };

  return {
    call(route, input) {
      return tracer.startActiveSpan("llm.call", async (span) => {
        // Tells the breaker how the API answered. A report that fails is noted, never thrown:
        // the reply is already here.
        let probeToken: string | null = null;
        const report = async (outcome: GuardOutcome) => {
          if (!guard) return;
          try {
            await guard.report(ANTHROPIC_DEPENDENCY, outcome, probeToken);
          } catch {
            span.setAttribute("northstar.llm.breaker_report_failed", true);
          }
        };
        try {
          // Built before the breaker is asked, so a bug in building it can't leave a probe
          // unreported (the breaker would stay half-open until the probe window ends).
          const { params, options } = buildRequest(route, input);
          // The spend cap first: a held-back call takes no breaker probe. A meter that throws
          // (the database down) holds the call back, like the guard (fail safe).
          if (budget) {
            const priority = route.priority ?? "normal";
            let cap: "daily" | "monthly" | "unknown" | "unrecorded" | null = null;
            // With no cap set nothing is checked (spend is still recorded below).
            const capped = budget.caps.dailyUsd !== null || budget.caps.monthlyUsd !== null;
            if (capped) {
              try {
                // Spend still owed to the meter first: while it can't be written, nothing runs.
                cap = (await flushUnrecorded(budget.meter))
                  ? budgetHold(await budget.meter.spent(), budget.caps, priority)
                  : "unrecorded";
              } catch (error) {
                cap = "unknown";
                // The error's name only, as the guard does: its message could name a host.
                span.setAttribute(
                  "northstar.llm.guard_error",
                  error instanceof Error ? error.name : "UnknownError",
                );
              }
            }
            if (cap !== null) {
              span.setAttributes({
                "northstar.llm.held_by": "budget",
                "northstar.llm.priority": priority,
              });
              throw new HeldBack("budget", cap);
            }
          }
          if (guard) {
            const admission = await admit(guard, {
              subsystem: agentSwitch(route.name),
              dependency: ANTHROPIC_DEPENDENCY,
            });
            if (!admission.ok) {
              span.setAttribute("northstar.llm.held_by", admission.held.by);
              // The error's name only: its message could name a host or a credential.
              if (admission.errorName !== null) {
                span.setAttribute("northstar.llm.guard_error", admission.errorName);
              }
              throw admission.held;
            }
            probeToken = admission.probeToken;
          }
          const started = deps.now();
          const message = await deps.client
            .create(params, options)
            .catch(async (error: unknown) => {
              const transport = toTransportError(error);
              // Only the API's own trouble counts against it. A non-retryable status (400, 401)
              // means it answered and our request or key is wrong.
              await report(
                transport.retryable ? { ok: false, error: transport.name } : { ok: true },
              );
              throw transport;
            });
          // Any reply, a refusal or a cut-off one included, is the API working.
          await report({ ok: true });
          const record = callRecord(route, message, deps.now() - started);
          // Spend is recorded for every reply, a refusal included: it was billed. Failing to
          // record is noted, never thrown (the reply is already here).
          if (budget) {
            // An unpriced reply counts at the dearest known model's prices, never as free.
            if (record.costUsd === null) span.setAttribute("northstar.llm.unpriced", true);
            const usd =
              record.costUsd ??
              ceilingCostUsd({
                inputTokens: record.inputTokens,
                outputTokens: record.outputTokens,
                cacheReadTokens: record.cacheReadTokens,
                cacheWriteTokens: record.cacheWriteTokens,
              });
            try {
              await budget.meter.record(route.name, usd);
            } catch {
              // Kept and written before the next call, which is held back until it is.
              unrecorded.push({ route: route.name, usd });
              span.setAttribute("northstar.llm.spend_record_failed", true);
            }
          }
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
              error instanceof LlmTransportError
                ? "TransportError"
                : error instanceof HeldBack
                  ? "HeldBack"
                  : "Error",
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
