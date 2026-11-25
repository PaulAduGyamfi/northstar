import { randomUUID } from "node:crypto";
import { type CandidateId, parseDomainEvent } from "@northstar/domain";
import { isSpanContextValid, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Db } from "./db.js";
import { domainEvent } from "./schema.js";

// Spans and events for the resilience write paths (NS-126; OBS-001, OBV-001): every change goes
// to the feed and has a span. Attributes carry names, statuses and counts only.

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const tracer = () => trace.getTracer("@northstar/db");

// Runs fn in a span; a throw marks it "DatabaseError" only, never row data.
export async function inSpan<R>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<R>,
): Promise<R> {
  return tracer().startActiveSpan(name, async (span) => {
    span.setAttributes(attributes);
    try {
      return await fn(span);
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "DatabaseError" });
      throw error;
    } finally {
      span.end();
    }
  });
}

// The span's trace id, or null when tracing is off (an all-zero context).
const traceIdOf = (span: Span): string | null => {
  const context = span.spanContext();
  return isSpanContextValid(context) ? context.traceId : null;
};

// Checks the event against the DomainEvent schema before it goes into the append-only log: a
// malformed row there could never be removed and would break every feed reader.
export async function appendEvent(
  tx: Tx,
  span: Span,
  e: {
    candidateId: CandidateId;
    aggregate: string;
    type: string;
    actor: "user" | "system";
    reason: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    at: Date;
  },
): Promise<void> {
  const parsed = parseDomainEvent({
    id: randomUUID(),
    candidateId: e.candidateId,
    aggregate: e.aggregate,
    type: e.type,
    actor: e.actor,
    reason: e.reason,
    inputsSummary: "",
    payload: e.payload,
    links: [],
    traceId: traceIdOf(span),
    idempotencyKey: e.idempotencyKey,
    occurredAt: e.at,
  });
  if (!parsed.ok) throw new Error(`invalid domain event: ${parsed.error.fields.join(", ")}`);
  await tx.insert(domainEvent).values(parsed.value);
}
