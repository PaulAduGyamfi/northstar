import { randomUUID } from "node:crypto";
import { type CandidateId, err, ok, type Result } from "@northstar/domain";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import {
  type CHANNELS,
  type FUNNEL_OUTCOMES,
  type FUNNEL_STAGES,
  funnelManualRow,
  funnelMessage,
  type MAIL_KINDS,
  type REVIEW_REASONS,
  type STAGE_SIGNALS,
} from "./funnel-schema.js";
import { domainEvent } from "./schema.js";

export type MailKind = (typeof MAIL_KINDS)[number];
export type StageSignal = (typeof STAGE_SIGNALS)[number];
export type ReviewReason = (typeof REVIEW_REASONS)[number];
export type FunnelStage = (typeof FUNNEL_STAGES)[number];
export type FunnelOutcome = (typeof FUNNEL_OUTCOMES)[number];
export type Channel = (typeof CHANNELS)[number];

// One processed Gmail message: ids, dates and extracted fields only, never a subject, body or
// address (NFR-SEC-005).
export type FunnelMessageInput = {
  gmailId: string;
  threadId: string;
  senderDomain: string | null;
  receivedAt: Date;
  status: "not_job" | "classified" | "needs_review";
  kind: MailKind | null;
  company: string | null;
  role: string | null;
  requisition: string | null;
  stageSignal: StageSignal | null;
  classifiedBy: "rules" | "model" | null;
  reviewReason: ReviewReason | null;
  promptVersion: number | null;
  model: string | null;
};

export type FunnelMessageRow = Omit<FunnelMessageInput, "status" | "classifiedBy"> & {
  id: string;
  status: "classified" | "needs_review" | "discarded";
  classifiedBy: "rules" | "model" | "paul" | null;
};

// Stores processed messages. A message already stored is skipped (safe to repeat), so a rerun of
// the backfill never changes what an earlier run or Paul's review decided. Returns how many were new.
export async function saveFunnelMessages(
  db: Db,
  candidateId: CandidateId,
  messages: FunnelMessageInput[],
): Promise<number> {
  if (messages.length === 0) return 0;
  const inserted = await db
    .insert(funnelMessage)
    .values(messages.map((m) => ({ ...m, candidateId })))
    .onConflictDoNothing({ target: [funnelMessage.candidateId, funnelMessage.gmailId] })
    .returning({ id: funnelMessage.id });
  return inserted.length;
}

// Which of these Gmail ids an earlier run already processed: the backfill skips them before
// fetching anything or calling the model.
export async function knownGmailIds(
  db: Db,
  candidateId: CandidateId,
  gmailIds: string[],
): Promise<Set<string>> {
  if (gmailIds.length === 0) return new Set();
  const rows = await db
    .select({ gmailId: funnelMessage.gmailId })
    .from(funnelMessage)
    .where(
      and(eq(funnelMessage.candidateId, candidateId), inArray(funnelMessage.gmailId, gmailIds)),
    );
  return new Set(rows.map((r) => r.gmailId));
}

// Every job message (not the pre-filter's drops), oldest first, for building funnel records.
export async function readFunnelMessages(
  db: Db,
  candidateId: CandidateId,
): Promise<FunnelMessageRow[]> {
  const rows = await db
    .select()
    .from(funnelMessage)
    .where(and(eq(funnelMessage.candidateId, candidateId), ne(funnelMessage.status, "not_job")))
    .orderBy(funnelMessage.receivedAt, funnelMessage.gmailId);
  return rows.map((r) => ({
    id: r.id,
    gmailId: r.gmailId,
    threadId: r.threadId,
    senderDomain: r.senderDomain,
    receivedAt: r.receivedAt,
    status: r.status as FunnelMessageRow["status"],
    kind: r.kind as MailKind | null,
    company: r.company,
    role: r.role,
    requisition: r.requisition,
    stageSignal: r.stageSignal as StageSignal | null,
    classifiedBy: r.classifiedBy as FunnelMessageRow["classifiedBy"],
    reviewReason: r.reviewReason as ReviewReason | null,
    promptVersion: r.promptVersion,
    model: r.model,
  }));
}

export type ReviewDecision =
  | {
      action: "classify";
      kind: MailKind;
      company: string;
      role: string | null;
      stageSignal: StageSignal;
    }
  | { action: "discard" };

export type ReviewError = { kind: "NotFound" } | { kind: "NotInReview" };

// Paul's decision on one review item (DX-001: nothing ambiguous lands silently). Classify stores
// the fields he gave, marked as his; discard keeps the row (so reruns skip it) out of the funnel.
// The event carries the action only, never what he typed.
export async function resolveReview(
  db: Db,
  input: { candidateId: CandidateId; messageId: string; decision: ReviewDecision },
): Promise<Result<{ status: "classified" | "discarded" }, ReviewError>> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ status: funnelMessage.status })
      .from(funnelMessage)
      .where(
        and(
          eq(funnelMessage.id, input.messageId),
          eq(funnelMessage.candidateId, input.candidateId),
        ),
      );
    if (!current) return err({ kind: "NotFound" } as const);
    if (current.status !== "needs_review") return err({ kind: "NotInReview" } as const);
    const d = input.decision;
    const status = d.action === "classify" ? "classified" : "discarded";
    await tx
      .update(funnelMessage)
      .set(
        d.action === "classify"
          ? {
              status,
              kind: d.kind,
              company: d.company,
              role: d.role,
              stageSignal: d.stageSignal,
              classifiedBy: "paul",
              updatedAt: sql`now()`,
            }
          : { status, updatedAt: sql`now()` },
      )
      .where(eq(funnelMessage.id, input.messageId));
    await insertEvent(tx, {
      candidateId: input.candidateId,
      type: "funnel.reviewed",
      reason: d.action === "classify" ? "Review item placed by Paul" : "Review item discarded",
      payload: { action: d.action },
      idempotencyKey: `funnel-review:${input.messageId}`,
    });
    return ok({ status } as const);
  });
}

// One row of Paul's tracker export (DX-002); `line` is its line in the file.
export type ManualRowInput = {
  line: number;
  company: string;
  role: string;
  appliedOn: string;
  stageReached: FunnelStage;
  outcome: FunnelOutcome;
  outcomeOn: string | null;
  channel: Channel | null;
};

// Replaces the current manual rows with a new export in one transaction. The same file (by hash)
// again changes nothing; a new one marks the old rows superseded instead of deleting them.
export async function setManualRows(
  db: Db,
  input: { candidateId: CandidateId; fileSha256: string; rows: ManualRowInput[] },
): Promise<{ status: "imported" | "unchanged"; rows: number }> {
  return db.transaction(async (tx) => {
    const active = and(
      eq(funnelManualRow.candidateId, input.candidateId),
      isNull(funnelManualRow.supersededAt),
    );
    const [current] = await tx
      .select({ sha: funnelManualRow.fileSha256 })
      .from(funnelManualRow)
      .where(active)
      .limit(1);
    if (current?.sha === input.fileSha256) {
      return { status: "unchanged", rows: input.rows.length } as const;
    }
    await tx.update(funnelManualRow).set({ supersededAt: sql`now()` }).where(active);
    if (input.rows.length > 0) {
      await tx.insert(funnelManualRow).values(
        input.rows.map((r) => ({
          ...r,
          candidateId: input.candidateId,
          fileSha256: input.fileSha256,
        })),
      );
    }
    await insertEvent(tx, {
      candidateId: input.candidateId,
      type: "funnel.imported",
      reason: "Tracker history imported",
      payload: { rows: input.rows.length },
      // Hash plus a random part: importing an older export again later is a new import.
      idempotencyKey: `funnel-import:${input.fileSha256}:${randomUUID()}`,
    });
    return { status: "imported", rows: input.rows.length } as const;
  });
}

// The current manual rows, in file order.
export async function readManualRows(db: Db, candidateId: CandidateId): Promise<ManualRowInput[]> {
  const rows = await db
    .select()
    .from(funnelManualRow)
    .where(and(eq(funnelManualRow.candidateId, candidateId), isNull(funnelManualRow.supersededAt)))
    .orderBy(funnelManualRow.line);
  return rows.map((r) => ({
    line: r.line,
    company: r.company,
    role: r.role,
    appliedOn: r.appliedOn,
    stageReached: r.stageReached as FunnelStage,
    outcome: r.outcome as FunnelOutcome,
    outcomeOn: r.outcomeOn,
    channel: r.channel as Channel | null,
  }));
}

// A run summary for the feed. Payloads are counts and fixed names only (a stage name, a cost):
// never a company, role, subject or address.
export async function recordFunnelEvent(
  db: Db,
  input: {
    candidateId: CandidateId;
    type: "funnel.backfilled" | "funnel.reported";
    reason: string;
    payload: Record<string, number | string | null>;
  },
): Promise<void> {
  await insertEvent(db, {
    candidateId: input.candidateId,
    type: input.type,
    reason: input.reason,
    payload: input.payload,
    // Every run is its own observation.
    idempotencyKey: `${input.type}:${randomUUID()}`,
  });
}

// The latest employment-facts check (NS-112), for hypothesis H11; null if Paul never ran one.
export async function latestFactsCheck(
  db: Db,
  candidateId: CandidateId,
): Promise<{ mismatches: number } | null> {
  const [row] = await db
    .select({ payload: domainEvent.payload })
    .from(domainEvent)
    .where(
      and(eq(domainEvent.candidateId, candidateId), eq(domainEvent.type, "profile.facts_checked")),
    )
    .orderBy(desc(domainEvent.position))
    .limit(1);
  if (!row) return null;
  const mismatches = (row.payload as { mismatches?: unknown }).mismatches;
  // An unreadable count is "unknown", not "no mismatch": H11 stays untested rather than weakened.
  return typeof mismatches === "number" ? { mismatches } : null;
}

async function insertEvent(
  db: Pick<Db, "insert">,
  e: {
    candidateId: CandidateId;
    type: string;
    reason: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  },
): Promise<void> {
  await db.insert(domainEvent).values({
    id: randomUUID(),
    candidateId: e.candidateId,
    aggregate: `candidate:${e.candidateId}`,
    type: e.type,
    // Every funnel command is Paul's own (`funnel ...` in his terminal).
    actor: "user",
    reason: e.reason,
    inputsSummary: "",
    payload: e.payload,
    links: [],
    traceId: null,
    idempotencyKey: e.idempotencyKey,
    occurredAt: new Date(),
  });
}
