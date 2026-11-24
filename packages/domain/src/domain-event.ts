import { z } from "zod";
import type { ApplicationStatus } from "./application-status.js";
import { CandidateId, EventId } from "./ids.js";
import { err, ok, type Result } from "./result.js";

// Who did it: a named agent (`agent:apply`), Paul himself (`user`) or plain code (`system`).
const Actor = z.string().regex(/^(agent:[a-z0-9-]+|user|system)$/);

// What it happened to, as `<kind>:<uuid>` (system-design §4: events are keyed by aggregate).
const Aggregate = z
  .string()
  .regex(/^[a-z_]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

// `<aggregate>.<what happened>`, e.g. `application.submitted` (ADR-0012).
const EventType = z.string().regex(/^[a-z_]+\.[a-z_]+$/);

// http(s) only: links come from untrusted job pages and the feed renders them as anchors, so a
// `javascript:` or `data:` href must never reach the append-only log, where it can't be removed.
const Link = z.object({ rel: z.string().min(1), href: z.url({ protocol: /^https?$/ }) }).strict();

// One schema for every domain event (OBS-001: actor, inputs summary, outputs, reason, links).
// strict() refuses unknown top-level fields. It does NOT check what goes inside reason,
// inputsSummary or payload: writers must keep email bodies, codes, tokens and resume text out.
// Typed payloads per event type should replace the open record before the first agent writer.
export const DomainEvent = z
  .object({
    id: EventId,
    candidateId: CandidateId,
    aggregate: Aggregate,
    type: EventType,
    actor: Actor,
    // Why it happened, in plain words for the feed. May be empty, never missing.
    reason: z.string().max(2000),
    inputsSummary: z.string().max(2000),
    // The outputs. For a status change: { from, to }.
    payload: z.record(z.string(), z.unknown()),
    links: z.array(Link),
    // W3C trace id of the span that produced the event; null when tracing is off.
    traceId: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .nullable(),
    idempotencyKey: z.string().min(1).max(200),
    occurredAt: z.date(),
  })
  .strict();

export type DomainEvent = z.infer<typeof DomainEvent>;

export type InvalidEvent = { kind: "InvalidEvent"; fields: string[] };

// Checks an event before anything writes it. The error names the bad fields, never their values.
export function parseDomainEvent(input: unknown): Result<DomainEvent, InvalidEvent> {
  const parsed = DomainEvent.safeParse(input);
  if (parsed.success) {
    return ok(parsed.data);
  }
  const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
  return err({ kind: "InvalidEvent", fields });
}

// The event type for a status change is named after the status it moves to (ADR-0012).
export function applicationEventType(to: ApplicationStatus): `application.${ApplicationStatus}` {
  return `application.${to}`;
}
