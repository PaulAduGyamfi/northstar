import type { ApplyAts, CandidateId, NeedsHumanReason } from "@northstar/domain";
import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { applySubmission } from "./apply-schema.js";
import { gateNow } from "./apply-write.js";
import type { Db } from "./db.js";
import { applyHandoff, applyHandoffDone } from "./handoff-schema.js";
import { pushNotification, pushNotificationResult } from "./push-schema.js";
import { appendEvent, inSpan } from "./resilience-event.js";
import { deadLetter } from "./resilience-schema.js";

// The handoff notifier's records (NS-193 slice 3, ADR-0032 item 6): which open handoffs still
// need a push, the one claim per handoff taken before any push goes out, and what it came to.
// At most once: a claim is never taken twice, and a claim with no result is reported, never
// re-sent. Events carry ids and counts only, never an endpoint or a push's words.

// A handoff's one push: claimed under this key, once, ever.
export const handoffNotifyKey = (handoffId: string): string => `apply_handoff:${handoffId}:notify`;

// How long a claim may wait for its result before it counts as an unknown outcome: longer than
// the notifier activity's 5-minute timeout, so an attempt still sending is never reported. Claims
// are stamped by now() and compared with the Gate's clock, which is now() outside tests.
export const PUSH_CLAIM_LEASE_SECONDS = 15 * 60;

// At most this many handoffs a pass: a burst of challenges never floods Paul's phone at once.
export const MAX_NOTIFY_PER_PASS = 20;

export type HandoffToNotify = { handoffId: string; ats: ApplyAts; reason: NeedsHumanReason };

// Paul's open handoffs with no claim yet, oldest first. A handoff he already resolved is never
// listed, and one already claimed (sent or not) never again.
export async function readHandoffsToNotify(
  db: Db,
  candidateId: CandidateId,
): Promise<HandoffToNotify[]> {
  const rows = await db
    .select({
      handoffId: applyHandoff.id,
      ats: applySubmission.ats,
      reason: applySubmission.reason,
    })
    .from(applyHandoff)
    .innerJoin(applySubmission, eq(applySubmission.id, applyHandoff.submissionId))
    .leftJoin(applyHandoffDone, eq(applyHandoffDone.handoffId, applyHandoff.id))
    .leftJoin(
      pushNotification,
      and(
        eq(pushNotification.candidateId, applyHandoff.candidateId),
        eq(
          pushNotification.itemKey,
          sql`'apply_handoff:' || ${applyHandoff.id}::text || ':notify'`,
        ),
      ),
    )
    .where(
      and(
        eq(applyHandoff.candidateId, candidateId),
        isNull(applyHandoffDone.id),
        isNull(pushNotification.id),
      ),
    )
    .orderBy(asc(applyHandoff.createdAt), asc(applyHandoff.id))
    .limit(MAX_NOTIFY_PER_PASS);
  return rows.map((r) => ({
    handoffId: r.handoffId,
    ats: r.ats as ApplyAts,
    reason: r.reason as NeedsHumanReason,
  }));
}

export type ClaimResult =
  | { kind: "claimed"; notificationId: string }
  // Another run (or an earlier pass) already claimed it: send nothing.
  | { kind: "already_claimed" }
  // Paul resolved it, or it isn't his: send nothing.
  | { kind: "resolved" }
  | { kind: "not_found" };

// Takes the handoff's one claim, under the handoff's own row lock: resolveHandoff takes the same
// lock, so a handoff resolved while this runs is either seen as resolved here or resolved after
// the claim, never both unseen.
export async function claimHandoffNotification(
  db: Db,
  candidateId: CandidateId,
  handoffId: string,
): Promise<ClaimResult> {
  return inSpan("db.push.claim", {}, (span) =>
    db.transaction(async (tx) => {
      const [h] = await tx
        .select({ id: applyHandoff.id })
        .from(applyHandoff)
        .where(and(eq(applyHandoff.id, handoffId), eq(applyHandoff.candidateId, candidateId)))
        .for("update");
      if (!h) return { kind: "not_found" as const };
      const [done] = await tx
        .select({ id: applyHandoffDone.id })
        .from(applyHandoffDone)
        .where(eq(applyHandoffDone.handoffId, handoffId));
      if (done) {
        span.setAttribute("northstar.push.claim", "resolved");
        return { kind: "resolved" as const };
      }
      const [row] = await tx
        .insert(pushNotification)
        .values({ candidateId, itemKey: handoffNotifyKey(handoffId) })
        .onConflictDoNothing({ target: [pushNotification.candidateId, pushNotification.itemKey] })
        .returning({ id: pushNotification.id });
      span.setAttribute("northstar.push.claim", row ? "claimed" : "already_claimed");
      return row
        ? { kind: "claimed" as const, notificationId: row.id }
        : { kind: "already_claimed" as const };
    }),
  );
}

export type PushCounts = { sent: number; gone: number; rejected: number };

// Records what a claim came to, once, with its feed line: `push.sent` when at least one browser
// took it, else `push.not_delivered`. A second record for the same claim stores nothing.
export async function recordPushResult(
  db: Db,
  input: { candidateId: CandidateId; notificationId: string; handoffId: string } & PushCounts,
): Promise<{ recorded: boolean }> {
  const outcome = input.sent > 0 ? "sent" : "failed";
  return inSpan("db.push.result", { "northstar.push.outcome": outcome }, (span) =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .insert(pushNotificationResult)
        .values({
          candidateId: input.candidateId,
          notificationId: input.notificationId,
          outcome,
          sentCount: input.sent,
          goneCount: input.gone,
          rejectedCount: input.rejected,
        })
        .onConflictDoNothing({ target: pushNotificationResult.notificationId })
        .returning({ createdAt: pushNotificationResult.createdAt });
      if (!row) return { recorded: false };
      await appendEvent(tx, span, {
        candidateId: input.candidateId,
        aggregate: `apply_handoff:${input.handoffId}`,
        type: outcome === "sent" ? "push.sent" : "push.not_delivered",
        actor: "system",
        // Fixed words only (db.md): the feed shows this line as it is.
        reason:
          outcome === "sent"
            ? "Sent you a notification: an application needs your hands"
            : "Couldn't deliver a notification about an application that needs your hands",
        payload: {
          notificationId: input.notificationId,
          sent: input.sent,
          gone: input.gone,
          rejected: input.rejected,
        },
        idempotencyKey: `push_notification:${input.notificationId}:result`,
        at: row.createdAt,
      });
      return { recorded: true };
    }),
  );
}

export type StaleClaim = { notificationId: string; itemKey: string };

// Claims older than the lease with no result and no outcome_unknown letter yet: a run that stopped between claim and result. The
// push may or may not have gone out, so it is reported, never sent again.
export async function readStalePushClaims(db: Db, candidateId: CandidateId): Promise<StaleClaim[]> {
  return db.transaction(async (tx) => {
    // The Gate's clock, as for the Apply ledger's stale claims (northstar_gate_now).
    const now = await gateNow(tx);
    const cutoff = new Date(now.getTime() - PUSH_CLAIM_LEASE_SECONDS * 1000);
    return tx
      .select({ notificationId: pushNotification.id, itemKey: pushNotification.itemKey })
      .from(pushNotification)
      .leftJoin(
        pushNotificationResult,
        eq(pushNotificationResult.notificationId, pushNotification.id),
      )
      .where(
        and(
          eq(pushNotification.candidateId, candidateId),
          isNull(pushNotificationResult.id),
          lt(pushNotification.createdAt, cutoff),
          // Already reported: listed once only, so older reports never crowd out newer ones.
          sql`not exists (select 1 from ${deadLetter} where ${deadLetter.candidateId} = ${pushNotification.candidateId} and ${deadLetter.idempotencyKey} = 'push:' || ${pushNotification.id}::text || ':unknown')`,
        ),
      )
      .orderBy(asc(pushNotification.createdAt))
      .limit(MAX_NOTIFY_PER_PASS);
  });
}
