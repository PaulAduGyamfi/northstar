import { randomUUID } from "node:crypto";
import {
  type BreakerState,
  type CallDecision,
  type CallOutcome,
  type CandidateId,
  CLOSED,
  onAcquire,
  onOutcome,
} from "@northstar/domain";
import { and, eq } from "drizzle-orm";
import type { Db } from "./db.js";
import { dependencyBreaker, NAME_PATTERN } from "./resilience-schema.js";
import { domainEvent } from "./schema.js";

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

// Saves the new state; on a change of status, also its event.
async function save(
  tx: Tx,
  row: Row,
  next: BreakerState,
  now: Date,
  traceId: string | null,
): Promise<void> {
  const prev = toState(row);
  if (JSON.stringify(prev) === JSON.stringify(next)) return;
  await tx
    .update(dependencyBreaker)
    .set({ ...next, updatedAt: now })
    .where(eq(dependencyBreaker.id, row.id));
  if (prev.status === next.status) return;
  const event = EVENT_FOR[next.status];
  await tx.insert(domainEvent).values({
    id: randomUUID(),
    candidateId: row.candidateId,
    aggregate: `dependency_breaker:${row.id}`,
    type: event.type,
    actor: "system",
    reason: event.reason,
    inputsSummary: "",
    payload: {
      dependency: row.dependency,
      from: prev.status,
      to: next.status,
      consecutiveFailures: next.consecutiveFailures,
      opens: next.opens,
      retryAt: next.retryAt?.toISOString() ?? null,
      lastError: next.lastError,
    },
    links: [],
    traceId,
    // One event per change of state: the row's id, the new status and the moment it changed.
    idempotencyKey: `breaker:${row.id}:${next.status}:${now.toISOString()}`,
    occurredAt: now,
  });
}

// May a call to this dependency go out now? `probe` marks the one trial call after a pause; the
// caller must report its outcome. Refused calls get when to try again and the last error name,
// so the UI can say "Gmail paused: RateLimited, retrying 14:05".
export async function acquireCall(
  db: Db,
  input: { candidateId: CandidateId; dependency: string; now?: Date; traceId?: string | null },
): Promise<CallDecision> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const row = await lockRow(tx, input.candidateId, input.dependency, now);
    const { decision, state } = onAcquire(toState(row), now);
    await save(tx, row, state, now, input.traceId ?? null);
    return decision;
  });
}

// Reports how a call went. A failure carries its error name only; a name that isn't one (a
// message, a URL) is stored as `Error`.
export async function recordCallOutcome(
  db: Db,
  input: {
    candidateId: CandidateId;
    dependency: string;
    outcome: CallOutcome;
    now?: Date;
    traceId?: string | null;
  },
): Promise<BreakerState> {
  const now = input.now ?? new Date();
  const outcome: CallOutcome = input.outcome.ok
    ? input.outcome
    : { ok: false, error: ERROR_NAME.test(input.outcome.error) ? input.outcome.error : "Error" };
  return db.transaction(async (tx) => {
    const row = await lockRow(tx, input.candidateId, input.dependency, now);
    const next = onOutcome(toState(row), outcome, now);
    await save(tx, row, next, now, input.traceId ?? null);
    return next;
  });
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
