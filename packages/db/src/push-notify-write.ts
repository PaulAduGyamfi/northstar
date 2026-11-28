import {
  type ApplyAts,
  type CandidateId,
  MAX_FRESH_AGE_MINUTES,
  type NeedsHumanReason,
} from "@northstar/domain";
import { and, asc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { FRESH_ALERT } from "./alert-write.js";
import { applySubmission } from "./apply-schema.js";
import { gateNow } from "./apply-write.js";
import type { Db } from "./db.js";
import { applyHandoff, applyHandoffDone } from "./handoff-schema.js";
import { pushNotification, pushNotificationResult } from "./push-schema.js";
import { appendEvent, inSpan } from "./resilience-event.js";
import { deadLetter } from "./resilience-schema.js";
import { domainEvent } from "./schema.js";

// The notifier's records (NS-193 slice 3, ADR-0032 item 6): which open handoffs and (NS-199) fresh
// job alerts still need a push, the one claim per item taken before any push goes out, and what it
// came to.
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

// A fresh-job alert's one push (NS-199 item 1): one per job, as the alert itself is
// (`job.fresh_alert:<jobId>`, alert-write.ts).
export const freshJobNotifyKey = (jobId: string): string => `job_fresh_alert:${jobId}:notify`;

// How recent a fresh-job alert must be to be pushed, by the Gate's clock: an older one is never
// pushed, so turning notifications on (or back on) doesn't send a backlog of stale jobs.
export const FRESH_PUSH_WINDOW_MINUTES = 60;

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

export type FreshAlertToNotify = { jobId: string; age: number; fit: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const wholeIn = (n: unknown, min: number, max: number): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;

// The candidate's fresh-job alerts from the last FRESH_PUSH_WINDOW_MINUTES with no claim yet,
// oldest first. Only `job.fresh_alert` events: a held alert (`job.fresh_alert_held`) is never
// read, so quiet hours stay what the alert pass decided, and a held alert is pushed once its own
// `job.fresh_alert` is recorded after them. The age and score come from the event's payload (ids
// and numbers only); a row whose numbers don't fit a push is left out, never guessed.
export async function readFreshAlertsToNotify(
  db: Db,
  candidateId: CandidateId,
): Promise<FreshAlertToNotify[]> {
  return inSpan("db.push.read_fresh_alerts", {}, (span) =>
    db.transaction(async (tx) => {
      // The window is read on the Gate's clock (the database's now()); the alert's occurred_at was
      // stamped by the alert pass's own clock. Both run on this one machine, so they differ by
      // moments, which only moves the window's edge, never lets an alert be pushed twice.
      const now = await gateNow(tx);
      const since = new Date(now.getTime() - FRESH_PUSH_WINDOW_MINUTES * 60_000);
      const rows = await tx
        .select({ payload: domainEvent.payload })
        .from(domainEvent)
        .where(
          and(
            eq(domainEvent.candidateId, candidateId),
            eq(domainEvent.type, FRESH_ALERT),
            gt(domainEvent.occurredAt, since),
            // Only a well-formed job id: one that isn't can't be claimed, so it never takes a
            // place in the batch.
            sql`(${domainEvent.payload} ->> 'jobId') ~ ${UUID.source}`,
            // Already claimed (sent or not): never again.
            sql`not exists (select 1 from ${pushNotification} where ${pushNotification.candidateId} = ${domainEvent.candidateId} and ${pushNotification.itemKey} = 'job_fresh_alert:' || (${domainEvent.payload} ->> 'jobId') || ':notify')`,
          ),
        )
        .orderBy(asc(domainEvent.occurredAt), asc(domainEvent.id))
        .limit(MAX_NOTIFY_PER_PASS);
      const alerts: FreshAlertToNotify[] = [];
      let malformed = 0;
      for (const { payload } of rows) {
        const { jobId, ageMinutes, score } = payload;
        if (
          typeof jobId !== "string" ||
          !UUID.test(jobId) ||
          !wholeIn(ageMinutes, 0, Number.MAX_SAFE_INTEGER) ||
          !wholeIn(score, 0, 100)
        ) {
          // Never guessed into a push, and never silent: counted on the span.
          malformed++;
          continue;
        }
        // A released alert can be older than a push names: it says the oldest age instead.
        alerts.push({ jobId, age: Math.min(ageMinutes, MAX_FRESH_AGE_MINUTES), fit: score });
      }
      span.setAttribute("northstar.push.fresh_alerts", alerts.length);
      span.setAttribute("northstar.push.malformed", malformed);
      return alerts;
    }),
  );
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

// Takes a fresh-job alert's one claim, only when the candidate's own `job.fresh_alert` for that
// job exists and is inside the push window by the Gate's clock, so no caller can push a stale
// alert whatever ids it passes. The unique key is the guard: a second claim stores nothing.
export async function claimFreshJobNotification(
  db: Db,
  candidateId: CandidateId,
  jobId: string,
): Promise<ClaimResult> {
  return inSpan("db.push.claim_fresh_job", {}, (span) =>
    db.transaction(async (tx) => {
      const now = await gateNow(tx);
      const since = new Date(now.getTime() - FRESH_PUSH_WINDOW_MINUTES * 60_000);
      const [alert] = await tx
        .select({ id: domainEvent.id })
        .from(domainEvent)
        .where(
          and(
            eq(domainEvent.candidateId, candidateId),
            eq(domainEvent.idempotencyKey, `${FRESH_ALERT}:${jobId}`),
            gt(domainEvent.occurredAt, since),
          ),
        );
      if (!alert) {
        span.setAttribute("northstar.push.claim", "not_found");
        return { kind: "not_found" as const };
      }
      const [row] = await tx
        .insert(pushNotification)
        .values({ candidateId, itemKey: freshJobNotifyKey(jobId) })
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

// What a claim was for: a handoff (NS-193) or a fresh job's alert (NS-199). It picks the event's
// aggregate and its fixed-word feed line.
export type PushSubject = { handoffId: string } | { jobId: string };

const RESULT_WORDS = {
  handoff: {
    sent: "Sent you a notification: an application needs your hands",
    failed: "Couldn't deliver a notification about an application that needs your hands",
  },
  fresh_job: {
    sent: "Sent you a notification: a fresh job fits you",
    failed: "Couldn't deliver a notification about a fresh job that fits you",
  },
} as const;

// Records what a claim came to, once, with its feed line: `push.sent` when at least one browser
// took it, else `push.not_delivered`. A second record for the same claim stores nothing.
export async function recordPushResult(
  db: Db,
  input: { candidateId: CandidateId; notificationId: string } & PushSubject & PushCounts,
): Promise<{ recorded: boolean }> {
  const outcome = input.sent > 0 ? "sent" : "failed";
  const subject =
    "jobId" in input
      ? { aggregate: `job:${input.jobId}`, words: RESULT_WORDS.fresh_job }
      : { aggregate: `apply_handoff:${input.handoffId}`, words: RESULT_WORDS.handoff };
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
        aggregate: subject.aggregate,
        type: outcome === "sent" ? "push.sent" : "push.not_delivered",
        actor: "system",
        // Fixed words only (db.md): the feed shows this line as it is.
        reason: subject.words[outcome],
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
