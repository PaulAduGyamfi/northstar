import { randomUUID } from "node:crypto";
import {
  type ApplyAts,
  type CandidateId,
  err,
  type NeedsHumanReason,
  ok,
  parseDomainEvent,
  type Result,
} from "@northstar/domain";
import { isSpanContextValid, type Span, trace } from "@opentelemetry/api";
import { and, asc, eq, isNull } from "drizzle-orm";
import { applySubmission } from "./apply-schema.js";
import type { Db } from "./db.js";
import { applyHandoff, applyHandoffDone, type HandoffOutcome } from "./handoff-schema.js";
import { domainEvent } from "./schema.js";

// Human handoffs (NS-121, APPLY-006, ACC-007): the one write path for apply_handoff and
// apply_handoff_done. A handoff is opened inside recordNeedsHuman's transaction (apply-write.ts);
// Paul resolves it here. Events carry ids, the ATS, the reason and the outcome: never the URL.

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// The reasons only Paul's hands can get past (ADR-0003): a handoff is opened for these alone.
export const CHALLENGE_REASONS: readonly NeedsHumanReason[] = [
  "captcha",
  "login",
  "mfa",
  "account",
];

export type HandoffView = {
  handoffId: string;
  submissionId: string;
  applicationId: string;
  ats: ApplyAts;
  reason: NeedsHumanReason;
  applyUrl: string;
  createdAt: Date;
};

async function appendEvent(
  tx: Tx,
  span: Span,
  candidateId: CandidateId,
  handoffId: string,
  what: "opened" | "resolved",
  payload: Record<string, unknown>,
  at: Date,
): Promise<void> {
  const context = span.spanContext();
  const parsed = parseDomainEvent({
    id: randomUUID(),
    candidateId,
    aggregate: `apply_handoff:${handoffId}`,
    type: `handoff.${what}`,
    actor: what === "opened" ? "agent:apply" : "user",
    reason: "",
    inputsSummary: "",
    payload,
    links: [],
    traceId: isSpanContextValid(context) ? context.traceId : null,
    idempotencyKey: `apply_handoff:${handoffId}:${what}`,
    occurredAt: at,
  });
  // Every field is built here, so a bad event is a bug, not an input error.
  if (!parsed.ok) throw new Error(`invalid handoff event: ${parsed.error.fields.join(", ")}`);
  await tx.insert(domainEvent).values(parsed.value);
}

// Opens a handoff for a submission just marked needs_human, in the caller's transaction. Only
// for a challenge reason with an apply URL; anything else opens nothing.
export async function openHandoff(
  tx: Tx,
  span: Span,
  input: {
    candidateId: CandidateId;
    submissionId: string;
    applicationId: string;
    ats: string;
    reason: NeedsHumanReason;
    applyUrl: string | undefined;
    now: Date;
  },
): Promise<void> {
  if (input.applyUrl === undefined || !CHALLENGE_REASONS.includes(input.reason)) return;
  const [row] = await tx
    .insert(applyHandoff)
    .values({
      candidateId: input.candidateId,
      submissionId: input.submissionId,
      applyUrl: input.applyUrl,
      createdAt: input.now,
    })
    .returning({ id: applyHandoff.id });
  if (!row) throw new Error("apply_handoff insert returned no row");
  span.setAttribute("northstar.apply.handoff", true);
  await appendEvent(
    tx,
    span,
    input.candidateId,
    row.id,
    "opened",
    {
      submissionId: input.submissionId,
      applicationId: input.applicationId,
      ats: input.ats,
      reason: input.reason,
    },
    input.now,
  );
}

// Paul's open handoffs, oldest first, with the page to open.
export async function listOpenHandoffs(db: Db, candidateId: CandidateId): Promise<HandoffView[]> {
  const rows = await db
    .select({
      handoffId: applyHandoff.id,
      submissionId: applyHandoff.submissionId,
      applicationId: applySubmission.applicationId,
      ats: applySubmission.ats,
      reason: applySubmission.reason,
      applyUrl: applyHandoff.applyUrl,
      createdAt: applyHandoff.createdAt,
    })
    .from(applyHandoff)
    .innerJoin(applySubmission, eq(applySubmission.id, applyHandoff.submissionId))
    .leftJoin(applyHandoffDone, eq(applyHandoffDone.handoffId, applyHandoff.id))
    .where(and(eq(applyHandoff.candidateId, candidateId), isNull(applyHandoffDone.id)))
    .orderBy(asc(applyHandoff.createdAt), asc(applyHandoff.id));
  return rows.map((r) => ({
    ...r,
    ats: r.ats as ApplyAts,
    reason: r.reason as NeedsHumanReason,
  }));
}

export type Resolved = { applicationId: string; outcome: HandoffOutcome; replayed: boolean };

// Records what Paul did with a handoff, once. A second call returns the first outcome and
// writes nothing, so a retried click is safe (RES-006).
export async function resolveHandoff(
  db: Db,
  input: { candidateId: CandidateId; handoffId: string; outcome: HandoffOutcome },
): Promise<Result<Resolved, { kind: "NotFound" }>> {
  return trace
    .getTracer("@northstar/db")
    .startActiveSpan("db.apply.handoff_resolve", async (span) => {
      try {
        span.setAttribute("northstar.handoff.outcome", input.outcome);
        return await db.transaction(async (tx) => {
          const [h] = await tx
            .select({ id: applyHandoff.id, applicationId: applySubmission.applicationId })
            .from(applyHandoff)
            .innerJoin(applySubmission, eq(applySubmission.id, applyHandoff.submissionId))
            .where(
              and(
                eq(applyHandoff.id, input.handoffId),
                eq(applyHandoff.candidateId, input.candidateId),
              ),
            )
            .for("update", { of: applyHandoff });
          if (!h) return err({ kind: "NotFound" as const });
          const [done] = await tx
            .select({ outcome: applyHandoffDone.outcome })
            .from(applyHandoffDone)
            .where(eq(applyHandoffDone.handoffId, h.id));
          if (done) {
            const outcome = done.outcome as HandoffOutcome;
            return ok({ applicationId: h.applicationId, outcome, replayed: true });
          }
          const now = new Date();
          await tx.insert(applyHandoffDone).values({
            candidateId: input.candidateId,
            handoffId: h.id,
            outcome: input.outcome,
            doneAt: now,
          });
          await appendEvent(
            tx,
            span,
            input.candidateId,
            h.id,
            "resolved",
            { applicationId: h.applicationId, outcome: input.outcome },
            now,
          );
          return ok({ applicationId: h.applicationId, outcome: input.outcome, replayed: false });
        });
      } finally {
        span.end();
      }
    });
}
