import {
  type BreakerState,
  type CallDecision,
  type CallOutcome,
  type CandidateId,
  CLOSED,
  onAcquire,
  onOutcome,
} from "@northstar/domain";
import type { Span } from "@opentelemetry/api";
import { and, eq } from "drizzle-orm";
import type { Db } from "./db.js";
import { appendEvent, inSpan } from "./resilience-event.js";
import { dependencyBreaker, NAME_PATTERN } from "./resilience-schema.js";

// Stored circuit breakers (RES-002, ADR-0007 item 3). The rules are packages/domain's; this file
// keeps one row per dependency, locks it while it changes, and writes an event on each change of
// state (opened, probing, closed), never on routine calls. Events carry the dependency, counts,
// the pause and an error name: never a message, URL or payload.

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Row = typeof dependencyBreaker.$inferSelect;

const NAME = new RegExp(NAME_PATTERN);
// An error name as the row stores it; anything else (a message, a URL) is kept out.
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const toState = (r: Row): BreakerState => ({
  status: r.status as BreakerState["status"],
  consecutiveFailures: r.consecutiveFailures,
  opens: r.opens,
  retryAt: r.retryAt,
  lastError: r.lastError,
});

// The dependency's row, created closed on first use, locked for this transaction.
async function lockRow(tx: Tx, candidateId: CandidateId, dependency: string, now: Date) {
  if (!NAME.test(dependency)) throw new Error("invalid dependency name");
  await tx
    .insert(dependencyBreaker)
    .values({ candidateId, dependency, ...CLOSED, updatedAt: now })
    .onConflictDoNothing({ target: [dependencyBreaker.candidateId, dependencyBreaker.dependency] });
  const [row] = await tx
    .select()
    .from(dependencyBreaker)
    .where(
      and(
        eq(dependencyBreaker.candidateId, candidateId),
        eq(dependencyBreaker.dependency, dependency),
      ),
    )
    .for("update");
  if (!row) throw new Error("dependency_breaker row missing after insert");
  return row;
}

const EVENT_FOR: Record<BreakerState["status"], { type: string; reason: string }> = {
  open: { type: "breaker.opened", reason: "Dependency paused after repeated failures" },
  half_open: { type: "breaker.probing", reason: "Dependency pause over; one probe call allowed" },
  closed: { type: "breaker.closed", reason: "Dependency recovered" },
};

const sameState = (a: BreakerState, b: BreakerState): boolean =>
  a.status === b.status &&
  a.consecutiveFailures === b.consecutiveFailures &&
  a.opens === b.opens &&
  a.retryAt?.getTime() === b.retryAt?.getTime() &&
  a.lastError === b.lastError;

// Saves the new state; on a change of status, also its event.
async function save(tx: Tx, span: Span, row: Row, next: BreakerState, now: Date): Promise<void> {
  const prev = toState(row);
  span.setAttribute("northstar.breaker.status", next.status);
  if (sameState(prev, next)) return;
  await tx
    .update(dependencyBreaker)
    .set({ ...next, updatedAt: now })
    .where(eq(dependencyBreaker.id, row.id));
  if (prev.status === next.status) return;
  const event = EVENT_FOR[next.status];
  await appendEvent(tx, span, {
    candidateId: row.candidateId as CandidateId,
    aggregate: `dependency_breaker:${row.id}`,
    type: event.type,
    actor: "system",
    reason: event.reason,
    payload: {
      dependency: row.dependency,
      from: prev.status,
      to: next.status,
      consecutiveFailures: next.consecutiveFailures,
      opens: next.opens,
      retryAt: next.retryAt?.toISOString() ?? null,
      lastError: next.lastError,
    },
    // One event per change of state. A status can't be entered twice at the same instant (each
    // change moves to a different status), so the row, the new status and the moment are unique.
    idempotencyKey: `breaker:${row.id}:${next.status}:${now.toISOString()}`,
    at: now,
  });
}

// May a call to this dependency go out now? `probe` marks the one trial call after a pause; the
// caller must report its outcome. Refused calls get when to try again and the last error name,
// so the UI can say "Gmail paused: RateLimited, retrying 14:05". A probe's caller passes its
// `probeToken` back to recordCallOutcome.
export async function acquireCall(
  db: Db,
  input: { candidateId: CandidateId; dependency: string; now?: Date },
): Promise<CallDecision> {
  const now = input.now ?? new Date();
  return inSpan("breaker.acquire", { "northstar.dependency": input.dependency }, (span) =>
    db.transaction(async (tx) => {
      const row = await lockRow(tx, input.candidateId, input.dependency, now);
      const { decision, state } = onAcquire(toState(row), now);
      await save(tx, span, row, state, now);
      span.setAttribute("northstar.breaker.allowed", decision.allowed);
      return decision;
    }),
  );
}

// Reports how a call went. A failure carries its error name only; a name that isn't one (a
// message, a URL) is stored as `Error`.
export async function recordCallOutcome(
  db: Db,
  input: {
    candidateId: CandidateId;
    dependency: string;
    outcome: CallOutcome;
    // The token acquireCall gave the probe; null for any other call.
    probeToken?: string | null;
    now?: Date;
  },
): Promise<BreakerState> {
  const now = input.now ?? new Date();
  const outcome: CallOutcome = input.outcome.ok
    ? input.outcome
    : { ok: false, error: ERROR_NAME.test(input.outcome.error) ? input.outcome.error : "Error" };
  return inSpan(
    "breaker.outcome",
    { "northstar.dependency": input.dependency, "northstar.breaker.call_ok": outcome.ok },
    (span) =>
      db.transaction(async (tx) => {
        const row = await lockRow(tx, input.candidateId, input.dependency, now);
        const next = onOutcome(toState(row), outcome, now, input.probeToken ?? null);
        await save(tx, span, row, next, now);
        return next;
      }),
  );
}

export type BreakerView = BreakerState & { dependency: string; updatedAt: Date };

// Every dependency's breaker, for the health view.
export async function readBreakers(db: Db, candidateId: CandidateId): Promise<BreakerView[]> {
  const rows = await db
    .select()
    .from(dependencyBreaker)
    .where(eq(dependencyBreaker.candidateId, candidateId))
    .orderBy(dependencyBreaker.dependency);
  return rows.map((r) => ({ ...toState(r), dependency: r.dependency, updatedAt: r.updatedAt }));
}
