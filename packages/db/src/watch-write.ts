import { randomUUID } from "node:crypto";
import type { CandidateId } from "@northstar/domain";
import { and, asc, eq, lte, ne, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { type ATS_KINDS, companyWatch, domainEvent, type WATCH_STATUSES } from "./schema.js";

// The watchlist's write path (NS-115, ADR-0015). packages/sources decides when a board is next
// due and whether it backs off or quarantines; this module only stores the result.

export type WatchAts = (typeof ATS_KINDS)[number];
export type WatchStatus = (typeof WATCH_STATUSES)[number];
export type WatchInput = { ats: WatchAts; board: string; url: string; tier: 1 | 2 | 3 };

export type Watch = WatchInput & {
  id: string;
  status: WatchStatus;
  nextPollAt: Date;
  lastPolledAt: Date | null;
  lastSuccessAt: Date | null;
  consecutiveFailures: number;
  lastError: string | null;
  jobsFound: number;
};

const toWatch = (r: typeof companyWatch.$inferSelect): Watch => ({
  id: r.id,
  ats: r.ats as WatchAts,
  board: r.board,
  url: r.url,
  tier: r.tier as 1 | 2 | 3,
  status: r.status as WatchStatus,
  nextPollAt: r.nextPollAt,
  lastPolledAt: r.lastPolledAt,
  lastSuccessAt: r.lastSuccessAt,
  consecutiveFailures: r.consecutiveFailures,
  lastError: r.lastError,
  jobsFound: r.jobsFound,
});

// Adds a board, due at once. The same board twice is reported, not duplicated.
export async function addWatch(
  db: Db,
  input: { candidateId: CandidateId; now: Date; watch: WatchInput },
): Promise<{ status: "added" | "exists"; id: string }> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: companyWatch.id })
      .from(companyWatch)
      .where(
        and(
          eq(companyWatch.candidateId, input.candidateId),
          eq(companyWatch.ats, input.watch.ats),
          eq(companyWatch.board, input.watch.board),
        ),
      );
    if (existing) return { status: "exists", id: existing.id } as const;
    const [row] = await tx
      .insert(companyWatch)
      .values({ candidateId: input.candidateId, ...input.watch, nextPollAt: input.now })
      .returning({ id: companyWatch.id });
    if (!row) throw new Error("company_watch insert returned no row");
    await insertEvent(
      tx,
      input.candidateId,
      row.id,
      "source.watched",
      "Board added to the watchlist",
      {
        ats: input.watch.ats,
        tier: input.watch.tier,
      },
    );
    return { status: "added", id: row.id } as const;
  });
}

export async function listWatches(db: Db, candidateId: CandidateId): Promise<Watch[]> {
  const rows = await db
    .select()
    .from(companyWatch)
    .where(eq(companyWatch.candidateId, candidateId))
    .orderBy(asc(companyWatch.tier), asc(companyWatch.createdAt));
  return rows.map(toWatch);
}

// The boards to poll now: their next poll has passed, and they aren't quarantined. Tier 1 first,
// so the tightest SLOs go first in a busy pass.
export async function dueWatches(db: Db, candidateId: CandidateId, now: Date): Promise<Watch[]> {
  const rows = await db
    .select()
    .from(companyWatch)
    .where(
      and(
        eq(companyWatch.candidateId, candidateId),
        lte(companyWatch.nextPollAt, now),
        ne(companyWatch.status, "quarantined"),
      ),
    )
    .orderBy(asc(companyWatch.tier), asc(companyWatch.nextPollAt));
  return rows.map(toWatch);
}

export type PollResult = {
  outcome: "ok" | "failed";
  seen: number;
  added: number;
  // The error's name only (TimeoutError, FetchRefused...), never its message.
  errorName: string | null;
};

export type NextState = { nextPollAt: Date; status: WatchStatus; consecutiveFailures: number };

// Stores one board's poll: its result, when it's next due and its status, with a counts-only
// `source.polled` event (and `source.quarantined` when it just got quarantined).
export async function savePollResult(
  db: Db,
  input: {
    candidateId: CandidateId;
    watchId: string;
    now: Date;
    result: PollResult;
    next: NextState;
  },
): Promise<void> {
  const { result, next } = input;
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ status: companyWatch.status, ats: companyWatch.ats, tier: companyWatch.tier })
      .from(companyWatch)
      .where(
        and(eq(companyWatch.id, input.watchId), eq(companyWatch.candidateId, input.candidateId)),
      );
    if (!before) return;
    await tx
      .update(companyWatch)
      .set({
        status: next.status,
        nextPollAt: next.nextPollAt,
        consecutiveFailures: next.consecutiveFailures,
        lastPolledAt: input.now,
        ...(result.outcome === "ok"
          ? { lastSuccessAt: input.now, lastError: null }
          : { lastError: result.errorName }),
        jobsFound: sql`${companyWatch.jobsFound} + ${result.added}`,
      })
      .where(eq(companyWatch.id, input.watchId));
    await insertEvent(tx, input.candidateId, input.watchId, "source.polled", "Board polled", {
      ats: before.ats,
      outcome: result.outcome,
      seen: result.seen,
      added: result.added,
      tier: before.tier,
    });
    if (next.status === "quarantined" && before.status !== "quarantined") {
      await insertEvent(
        tx,
        input.candidateId,
        input.watchId,
        "source.quarantined",
        "Board quarantined after repeated failures",
        {
          ats: before.ats,
          failures: next.consecutiveFailures,
          error: result.errorName ?? "unknown",
        },
      );
    }
  });
}

// Paul's "try this board again": back to ok, failures cleared, due now.
export async function retryWatch(
  db: Db,
  input: { candidateId: CandidateId; watchId: string; now: Date },
): Promise<boolean> {
  const rows = await db
    .update(companyWatch)
    .set({ status: "ok", consecutiveFailures: 0, nextPollAt: input.now })
    .where(and(eq(companyWatch.id, input.watchId), eq(companyWatch.candidateId, input.candidateId)))
    .returning({ id: companyWatch.id });
  return rows.length > 0;
}

export async function removeWatch(
  db: Db,
  input: { candidateId: CandidateId; watchId: string },
): Promise<boolean> {
  const rows = await db
    .delete(companyWatch)
    .where(and(eq(companyWatch.id, input.watchId), eq(companyWatch.candidateId, input.candidateId)))
    .returning({ id: companyWatch.id });
  return rows.length > 0;
}

async function insertEvent(
  tx: Pick<Db, "insert">,
  candidateId: CandidateId,
  watchId: string,
  type: "source.watched" | "source.polled" | "source.quarantined",
  reason: string,
  // Counts, ATS kinds, tiers and error names only: never a board name, company or URL.
  payload: Record<string, string | number>,
): Promise<void> {
  await tx.insert(domainEvent).values({
    id: randomUUID(),
    candidateId,
    aggregate: `company_watch:${watchId}`,
    type,
    actor: type === "source.watched" ? "user" : "system",
    reason,
    inputsSummary: "",
    payload,
    links: [],
    traceId: null,
    idempotencyKey: `${type}:${watchId}:${randomUUID()}`,
    occurredAt: new Date(),
  });
}
