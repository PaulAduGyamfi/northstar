import { randomUUID } from "node:crypto";
import {
  type ApplicationId,
  type ApplicationStatus,
  applicationEventType,
  type CandidateId,
  type DomainEvent,
  err,
  type IllegalTransition,
  type InvalidEvent,
  isApplicationStatus,
  nextStatus,
  ok,
  parseDomainEvent,
  type Result,
  type SubmittedVia,
} from "@northstar/domain";
import { isSpanContextValid, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { and, eq } from "drizzle-orm";
import type { Db } from "./db.js";
import { rowToStoredEvent, type StoredEvent } from "./events.js";
import { application, domainEvent } from "./schema.js";

export type TransitionInput = {
  candidateId: CandidateId;
  applicationId: ApplicationId;
  // The status the caller believes the application is in. The write only happens if it still is.
  from: ApplicationStatus;
  to: ApplicationStatus;
  actor: string;
  reason: string;
  inputsSummary: string;
  links: { rel: string; href: string }[];
  // Same key, same move: the second call returns the first event and changes nothing (RES-006).
  // The key names one attempt, not one kind of move: a legal loop (queued → … → awaiting_approval
  // → queued) needs a fresh key each time round, or the second lap silently replays the first.
  idempotencyKey: string;
  // How it went out (INB-007): required for a move to `submitted`, and stored in that move's
  // event, so the origin is written in the same transaction as the move. Ignored otherwise.
  submittedVia?: SubmittedVia;
  // A fixed code for why the move happened (NS-218: `posting_closed`), stored in the event's
  // payload so the feed can say so. Never free text: no title, company or URL.
  reasonCode?: string;
  // Injected clock for tests; defaults to the current time.
  now?: Date;
};

export type StaleStatus = {
  kind: "StaleStatus";
  applicationId: string;
  expected: ApplicationStatus;
  actual: ApplicationStatus;
};
export type NotFound = { kind: "NotFound"; applicationId: string };
export type IdempotencyKeyReused = { kind: "IdempotencyKeyReused"; idempotencyKey: string };
// A move to `submitted` that doesn't say how it went out (INB-007).
export type MissingSubmittedVia = { kind: "MissingSubmittedVia" };

export type TransitionError =
  | IllegalTransition
  | InvalidEvent
  | StaleStatus
  | NotFound
  | IdempotencyKeyReused
  | MissingSubmittedVia;

export type TransitionResult = StoredEvent & { replayed: boolean };

// Raised inside the transaction to roll it back; turned back into a value below.
class Rollback extends Error {
  constructor(readonly reason: TransitionError) {
    super(reason.kind);
  }
}

const tracer = () => trace.getTracer("@northstar/db");

// Moves an application to a new status and appends its domain event in one transaction
// (the outbox pattern, ADR-0012). Expected refusals come back as values, never half-written.
export async function transitionApplication(
  db: Db,
  input: TransitionInput,
): Promise<Result<TransitionResult, TransitionError>> {
  return tracer().startActiveSpan("db.application.transition", async (span) => {
    span.setAttributes({
      "northstar.application.id": input.applicationId,
      "northstar.status.from": input.from,
      "northstar.status.to": input.to,
    });
    try {
      const result = await transition(db, input, span);
      span.setAttribute("northstar.idempotent_replay", result.ok && result.value.replayed);
      if (!result.ok) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: result.error.kind });
      }
      return result;
    } catch (error) {
      // A driver or database failure: record the kind only, never row data.
      span.setStatus({ code: SpanStatusCode.ERROR, message: "DatabaseError" });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function transition(
  db: Db,
  input: TransitionInput,
  span: Span,
): Promise<Result<TransitionResult, TransitionError>> {
  // 1. Plain code decides whether the move is legal (ADR-0007). No database work if it isn't.
  const legal = nextStatus(input.from, input.to);
  if (!legal.ok) return legal;
  const submitted = input.to === "submitted";
  if (submitted && input.submittedVia === undefined) return err({ kind: "MissingSubmittedVia" });

  // 2. Build and check the event before the transaction starts, so a bad one writes nothing.
  const spanContext = span.spanContext();
  const aggregate = `application:${input.applicationId}`;
  const parsed = parseDomainEvent({
    id: randomUUID(),
    candidateId: input.candidateId,
    aggregate,
    type: applicationEventType(input.to),
    actor: input.actor,
    reason: input.reason,
    inputsSummary: input.inputsSummary,
    payload: {
      from: input.from,
      to: input.to,
      ...(submitted ? { submittedVia: input.submittedVia } : {}),
      ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
    },
    links: input.links,
    // A no-op tracer (OpenTelemetry not set up) has an all-zero context: store null instead.
    traceId: isSpanContextValid(spanContext) ? spanContext.traceId : null,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.now ?? new Date(),
  });
  if (!parsed.ok) return parsed;
  const event = parsed.value;

  try {
    const stored = await db.transaction(async (tx) => {
      // 3. A repeat of a move that already happened: hand back the original event.
      const before = await findReplay(tx, event);
      if (before) return before;

      // 4. Conditional update: only succeeds if the status is still `from`, so of two racing
      //    workers exactly one wins.
      const moved = await tx
        .update(application)
        .set({ status: input.to, updatedAt: event.occurredAt })
        .where(
          and(
            eq(application.id, input.applicationId),
            eq(application.candidateId, input.candidateId),
            eq(application.status, input.from),
          ),
        )
        .returning({ id: application.id });

      if (moved.length === 0) {
        // A concurrent call with the same key may have committed in the meantime.
        const raced = await findReplay(tx, event);
        if (raced) return raced;
        throw new Rollback(await whyNotMoved(tx, input));
      }

      // 5. Append the event in the same transaction as the status change.
      const [row] = await tx.insert(domainEvent).values(event).returning();
      if (!row) throw new Error("domain_event insert returned no row");
      return { ...rowToStoredEvent(row), replayed: false };
    });
    return ok(stored);
  } catch (error) {
    if (error instanceof Rollback) return err(error.reason);
    throw error;
  }
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// The stored event for this idempotency key, if the same move already happened.
async function findReplay(tx: Tx, event: DomainEvent): Promise<TransitionResult | null> {
  const [row] = await tx
    .select()
    .from(domainEvent)
    .where(
      and(
        eq(domainEvent.candidateId, event.candidateId),
        eq(domainEvent.idempotencyKey, event.idempotencyKey),
      ),
    );
  if (!row) return null;
  // The key must describe the same move, or a caller reused a key by mistake.
  const sameMove =
    row.aggregate === event.aggregate &&
    row.type === event.type &&
    row.payload.from === event.payload.from &&
    // A repeat must say the same about how it went out (INB-007).
    row.payload.submittedVia === event.payload.submittedVia &&
    // And the same about why (NS-218).
    row.payload.reasonCode === event.payload.reasonCode;
  if (!sameMove) {
    throw new Rollback({ kind: "IdempotencyKeyReused", idempotencyKey: event.idempotencyKey });
  }
  return { ...rowToStoredEvent(row), replayed: true };
}

// After an update that touched no row: the application is missing or has moved on.
async function whyNotMoved(tx: Tx, input: TransitionInput): Promise<NotFound | StaleStatus> {
  const [row] = await tx
    .select({ status: application.status })
    .from(application)
    .where(
      and(eq(application.id, input.applicationId), eq(application.candidateId, input.candidateId)),
    );
  // An unknown status can't happen (the CHECK constraint refuses it); it only narrows the type.
  if (!row || !isApplicationStatus(row.status)) {
    return { kind: "NotFound", applicationId: input.applicationId };
  }
  return {
    kind: "StaleStatus",
    applicationId: input.applicationId,
    expected: input.from,
    actual: row.status,
  };
}
