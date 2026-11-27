import type { CandidateId } from "@northstar/domain";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { gateNow } from "./apply-write.js";
import type { Db } from "./db.js";
import { interviewDetection, interviewPrepProposal } from "./interview-schema.js";
import { northstarCalendar, prepWriteClaim, prepWriteRecord } from "./prep-plan-schema.js";
import { appendEvent, inSpan } from "./resilience-event.js";

// The Calendar writer's ledger (NS-241 slice 4, ADR-0031 item 5, RES-006): one approval writes its
// blocks once, and the candidate has one Northstar calendar. The database side of writePrepPlan's
// ports in @northstar/gateways. Ids, counts and times only.

// How long a claim counts as a live run: longer than the writer's 30 s request timeout times the
// requests one run makes (a lookup, a create, three inserts), with room to spare.
export const PREP_CLAIM_LEASE_MS = 5 * 60_000;
// The schema's attempt bound: a claim past it is refused by name, never as a raw CHECK error.
export const MAX_PREP_CLAIMS = 100;

// The claim's answer, shared with the gateway's ports (packages/gateways imports this type).
export type PrepClaim =
  | { state: "new" }
  | { state: "done"; blockCount: number }
  | { state: "in_progress"; retryAt: Date }
  | { state: "unknown" };

export class PrepClaimsExhausted extends Error {
  constructor() {
    super("too many lapsed claims on this decision");
    this.name = "PrepClaimsExhausted";
  }
}

export class PrepRecordConflict extends Error {
  constructor() {
    super("a different write is already recorded for this decision");
    this.name = "PrepRecordConflict";
  }
}

export class NorthstarCalendarConflict extends Error {
  constructor() {
    super("a different Northstar calendar is already stored");
    this.name = "NorthstarCalendarConflict";
  }
}

// The writer's own CALENDAR_ID rule and the table's CHECK.
const CALENDAR_ID = /^[a-z0-9_]{1,128}@group\.calendar\.google\.com$/;
const Uuid = z.string().uuid();

// Claims a decision for one run. One prep write at a time per candidate: any live claim of the
// candidate's that has no record yet, for this decision or another, answers `in_progress`, so two
// runs can't each create a Northstar calendar. `new` and `unknown` both take a claim; `unknown`
// (this decision's earlier claim lapsed) tells the writer an earlier run may have written part of
// the plan before it died.
export async function claimPrepWrite(
  db: Db,
  candidateId: CandidateId,
  decisionId: string,
): Promise<PrepClaim> {
  if (!Uuid.safeParse(decisionId).success) throw new Error("invalid decision id");
  return inSpan("db.prep_write.claim", {}, (span) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`prep_write:${candidateId}`}))`);
      const [record] = await tx
        .select({ blockCount: prepWriteRecord.blockCount })
        .from(prepWriteRecord)
        .where(
          and(
            eq(prepWriteRecord.candidateId, candidateId),
            eq(prepWriteRecord.decisionId, decisionId),
          ),
        );
      if (record) {
        span.setAttribute("northstar.prep_write.claim", "done");
        return { state: "done" as const, blockCount: record.blockCount };
      }
      // The database's clock, as the draft ledger's: hosts whose clocks disagree still agree on
      // whether a lease has lapsed.
      const at = await gateNow(tx);
      const since = new Date(at.getTime() - PREP_CLAIM_LEASE_MS);
      const [live] = await tx
        .select({ claimedAt: prepWriteClaim.claimedAt })
        .from(prepWriteClaim)
        .where(
          and(
            eq(prepWriteClaim.candidateId, candidateId),
            gt(prepWriteClaim.claimedAt, since),
            sql`not exists (
              select 1 from ${prepWriteRecord} r
              where r.candidate_id = ${prepWriteClaim.candidateId}
                and r.decision_id = ${prepWriteClaim.decisionId}
            )`,
          ),
        )
        .orderBy(desc(prepWriteClaim.claimedAt))
        .limit(1);
      if (live) {
        span.setAttribute("northstar.prep_write.claim", "in_progress");
        return {
          state: "in_progress" as const,
          retryAt: new Date(live.claimedAt.getTime() + PREP_CLAIM_LEASE_MS),
        };
      }
      const [latest] = await tx
        .select({ attempt: prepWriteClaim.attempt })
        .from(prepWriteClaim)
        .where(
          and(
            eq(prepWriteClaim.candidateId, candidateId),
            eq(prepWriteClaim.decisionId, decisionId),
          ),
        )
        .orderBy(desc(prepWriteClaim.attempt))
        .limit(1);
      if ((latest?.attempt ?? 0) >= MAX_PREP_CLAIMS) throw new PrepClaimsExhausted();
      await tx.insert(prepWriteClaim).values({
        candidateId,
        decisionId,
        attempt: (latest?.attempt ?? 0) + 1,
        claimedAt: at,
      });
      const state = latest ? ("unknown" as const) : ("new" as const);
      span.setAttribute("northstar.prep_write.claim", state);
      return { state };
    }),
  );
}

// The feed line, from a count and fixed words only (ADR-0031 item 7).
export function prepWrittenReason(blocks: number): string {
  return `Added ${blocks === 1 ? "1 prep block" : `${blocks} prep blocks`} to your Northstar calendar`;
}

// Records a decision's write with its `calendar.prep_written` event, once. The same record again
// stores nothing; a different one is refused, because one approval writes one plan.
export async function recordPrepWrite(
  db: Db,
  candidateId: CandidateId,
  input: { decisionId: string; proposalId: string; blockCount: number },
): Promise<void> {
  if (!Uuid.safeParse(input.decisionId).success || !Uuid.safeParse(input.proposalId).success) {
    throw new Error("invalid id");
  }
  if (!Number.isInteger(input.blockCount) || input.blockCount < 1 || input.blockCount > 10) {
    throw new Error("invalid block count");
  }
  await inSpan("db.prep_write.record", {}, (span) =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .insert(prepWriteRecord)
        .values({ candidateId, ...input, recordedAt: await gateNow(tx) })
        .onConflictDoNothing({ target: [prepWriteRecord.candidateId, prepWriteRecord.decisionId] })
        .returning({ id: prepWriteRecord.id, recordedAt: prepWriteRecord.recordedAt });
      if (!row) {
        const [existing] = await tx
          .select({
            proposalId: prepWriteRecord.proposalId,
            blockCount: prepWriteRecord.blockCount,
          })
          .from(prepWriteRecord)
          .where(
            and(
              eq(prepWriteRecord.candidateId, candidateId),
              eq(prepWriteRecord.decisionId, input.decisionId),
            ),
          );
        if (existing?.proposalId !== input.proposalId || existing.blockCount !== input.blockCount) {
          throw new PrepRecordConflict();
        }
        span.setAttribute("northstar.prep_write.record", "already");
        return;
      }
      span.setAttribute("northstar.prep_write.record", "recorded");
      // The application the interview is for, so the event shows on its timeline.
      const [owner] = await tx
        .select({ applicationId: interviewDetection.applicationId })
        .from(interviewPrepProposal)
        .innerJoin(interviewDetection, eq(interviewDetection.id, interviewPrepProposal.detectionId))
        .where(
          and(
            eq(interviewPrepProposal.id, input.proposalId),
            eq(interviewPrepProposal.candidateId, candidateId),
          ),
        );
      await appendEvent(tx, span, {
        candidateId,
        aggregate: `prep_write_record:${row.id}`,
        type: "calendar.prep_written",
        actor: "system",
        // The feed shows this reason (no template): fixed words and a count only.
        reason: prepWrittenReason(input.blockCount),
        payload: {
          applicationId: owner?.applicationId ?? null,
          decisionId: input.decisionId,
          proposalId: input.proposalId,
          blocks: input.blockCount,
        },
        idempotencyKey: `prep_write:${candidateId}:${input.decisionId}:recorded`,
        at: row.recordedAt,
      });
    }),
  );
}

// The candidate's Northstar calendar id, or null before the writer created it.
export async function readNorthstarCalendar(
  db: Db,
  candidateId: CandidateId,
): Promise<string | null> {
  const [row] = await db
    .select({ calendarId: northstarCalendar.calendarId })
    .from(northstarCalendar)
    .where(eq(northstarCalendar.candidateId, candidateId));
  return row?.calendarId ?? null;
}

// Stores the calendar's id as soon as Google names it, once per candidate, with a
// `calendar.created` event. The same id again stores nothing; a different one is refused.
export async function saveNorthstarCalendar(
  db: Db,
  candidateId: CandidateId,
  calendarId: string,
): Promise<void> {
  if (!CALENDAR_ID.test(calendarId)) throw new Error("invalid calendar id");
  await inSpan("db.northstar_calendar.save", {}, (span) =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .insert(northstarCalendar)
        .values({ candidateId, calendarId, savedAt: await gateNow(tx) })
        .onConflictDoNothing({ target: northstarCalendar.candidateId })
        .returning({ id: northstarCalendar.id, savedAt: northstarCalendar.savedAt });
      if (!row) {
        const stored = await readNorthstarCalendar(tx as unknown as Db, candidateId);
        if (stored !== calendarId) throw new NorthstarCalendarConflict();
        span.setAttribute("northstar.northstar_calendar.save", "already");
        return;
      }
      span.setAttribute("northstar.northstar_calendar.save", "saved");
      await appendEvent(tx, span, {
        candidateId,
        aggregate: `northstar_calendar:${row.id}`,
        type: "calendar.created",
        actor: "system",
        // Fixed words; never the calendar's id.
        reason: "Set up your Northstar calendar for prep blocks",
        payload: {},
        idempotencyKey: `northstar_calendar:${candidateId}`,
        at: row.savedAt,
      });
    }),
  );
}

// Binds the ledger to writePrepPlan's ports.
export function dbCalendarLedger(db: Db) {
  return {
    claimPrepWrite: (candidateId: CandidateId, decisionId: string) =>
      claimPrepWrite(db, candidateId, decisionId),
    recordPrepWrite: (
      candidateId: CandidateId,
      input: { decisionId: string; proposalId: string; blockCount: number },
    ) => recordPrepWrite(db, candidateId, input),
    readNorthstarCalendar: (candidateId: CandidateId) => readNorthstarCalendar(db, candidateId),
    saveNorthstarCalendar: (candidateId: CandidateId, calendarId: string) =>
      saveNorthstarCalendar(db, candidateId, calendarId),
  };
}
