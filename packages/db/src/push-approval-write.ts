import { type ApprovalKind, type CandidateId, MAX_WAITING_MORE } from "@northstar/domain";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  approvalDecision,
  approvalEdit,
  approvalRequest,
  approvalUndo,
  approvalWithdrawal,
} from "./approval-schema.js";
import type { Db } from "./db.js";
import type { ClaimResult, PushCounts } from "./push-notify-write.js";
import { pushNotification, pushNotificationResult } from "./push-schema.js";
import { appendEvent, inSpan } from "./resilience-event.js";

// Approval pushes' records (NS-204 slice 2, APR-003, ADR-0032 item 6): which requests waiting in
// Paul's Queue still need a push, the one claim per request taken before any push goes out, and
// what it came to. A push never approves: it only opens the Queue (decision on #162).
// At most once, as for handoffs: a request is claimed once, ever, whether its push went out alone
// or as part of an overflow push, and a claim with no result is reported, never re-sent. Events
// carry ids and counts only, never a subject, a draft or a push's words.

// A request's one push: claimed under this key, once, ever.
export const approvalNotifyKey = (requestId: string): string =>
  `approval_request:${requestId}:notify`;

// At most this many requests get a push of their own each pass; the rest of the pass's requests
// share one overflow push ("N more waiting"), so a burst never floods Paul's phone.
export const MAX_APPROVAL_PUSHES_PER_PASS = 5;

// At most this many waiting requests are read a pass: the ones pushed alone and the most one
// overflow push may count. Any beyond wait for the next pass.
export const MAX_APPROVALS_READ = MAX_APPROVAL_PUSHES_PER_PASS + MAX_WAITING_MORE;

export type ApprovalToNotify = { requestId: string; kind: ApprovalKind };

// A request waits for Paul while it has no live decision (none, or each one undone) and isn't
// withdrawn: listPendingApprovals' own rule. A request a policy approved has its decision from the
// start, so it never waits and is never pushed. The outer columns are written out with their
// table: inside a subquery a bare "id" would be the subquery's own.
const waiting = sql`not exists (
  select 1 from ${approvalWithdrawal} w where w.request_id = "approval_request"."id"
) and not exists (
  select 1 from ${approvalDecision} d
  where d.request_id = "approval_request"."id"
    and not exists (select 1 from ${approvalUndo} u where u.decision_id = d.id)
)`;

// Paul's own edit files a new request (NS-203): he made it himself, so it isn't news to him.
const notEdited = sql`not exists (
  select 1 from ${approvalEdit} e
  where e.request_id = "approval_request"."id"
    and e.candidate_id = "approval_request"."candidate_id"
)`;

// Reveals are filed, approved and used in one transaction (ADR-0024): never in the Queue, and a
// push may never name one.
const notReveal = sql`"approval_request"."kind" <> 'vault_reveal'`;

// The requests waiting in Paul's Queue with no claim yet, oldest first: never a reveal, a request
// a policy approved, one he decided, withdrew or edited, or one already claimed (sent or not).
export async function readApprovalsToNotify(
  db: Db,
  candidateId: CandidateId,
): Promise<ApprovalToNotify[]> {
  return inSpan("db.push.read_approvals", {}, async (span) => {
    const rows = await db
      .select({ requestId: approvalRequest.id, kind: approvalRequest.kind })
      .from(approvalRequest)
      .where(
        and(
          eq(approvalRequest.candidateId, candidateId),
          notReveal,
          waiting,
          notEdited,
          sql`not exists (select 1 from ${pushNotification} where ${pushNotification.candidateId} = "approval_request"."candidate_id" and ${pushNotification.itemKey} = 'approval_request:' || "approval_request"."id"::text || ':notify')`,
        ),
      )
      .orderBy(asc(approvalRequest.requestedAt), asc(approvalRequest.id))
      .limit(MAX_APPROVALS_READ);
    span.setAttribute("northstar.push.approvals", rows.length);
    return rows.map((r) => ({ requestId: r.requestId, kind: r.kind as ApprovalKind }));
  });
}

// Takes a request's one claim, under the request's own row lock: deciding (decideApprovals) locks
// the same row, so a request decided while this runs is either seen as decided here or decided
// after the claim. A withdrawal or decision that lands after the claim can still leave a push for
// a request no longer waiting; its tap then says so in the Queue, and nothing is decided from it.
export async function claimApprovalNotification(
  db: Db,
  candidateId: CandidateId,
  requestId: string,
): Promise<ClaimResult> {
  return inSpan("db.push.claim_approval", {}, (span) =>
    db.transaction(async (tx) => {
      const [request] = await tx
        .select({ id: approvalRequest.id })
        .from(approvalRequest)
        .where(and(eq(approvalRequest.id, requestId), eq(approvalRequest.candidateId, candidateId)))
        .for("update");
      if (!request) {
        span.setAttribute("northstar.push.claim", "not_found");
        return { kind: "not_found" as const };
      }
      // The reader's rules again, now under the lock.
      const [open] = await tx
        .select({ id: approvalRequest.id })
        .from(approvalRequest)
        .where(and(eq(approvalRequest.id, requestId), notReveal, waiting, notEdited));
      if (!open) {
        span.setAttribute("northstar.push.claim", "resolved");
        return { kind: "resolved" as const };
      }
      const [row] = await tx
        .insert(pushNotification)
        .values({ candidateId, itemKey: approvalNotifyKey(requestId) })
        .onConflictDoNothing({ target: [pushNotification.candidateId, pushNotification.itemKey] })
        .returning({ id: pushNotification.id });
      span.setAttribute("northstar.push.claim", row ? "claimed" : "already_claimed");
      return row
        ? { kind: "claimed" as const, notificationId: row.id }
        : { kind: "already_claimed" as const };
    }),
  );
}

// Claims a set of requests for one overflow push, all or nothing (NS-204 slice 2): one
// transaction locks the rows (in id order, so two runs never deadlock), keeps those still waiting
// and inserts their claims in one statement. A failure anywhere leaves no claim at all, so an
// overflow push can never strand claims with no push; a request already claimed is left out.
// Answers the claims taken, in the order asked.
export async function claimApprovalNotifications(
  db: Db,
  candidateId: CandidateId,
  requestIds: readonly string[],
): Promise<Array<{ notificationId: string; requestId: string }>> {
  const wanted = [...new Set(requestIds)];
  if (wanted.length === 0) return [];
  return inSpan("db.push.claim_approvals", { "northstar.push.asked": wanted.length }, (span) =>
    db.transaction(async (tx) => {
      await tx
        .select({ id: approvalRequest.id })
        .from(approvalRequest)
        .where(
          and(eq(approvalRequest.candidateId, candidateId), inArray(approvalRequest.id, wanted)),
        )
        .orderBy(asc(approvalRequest.id))
        .for("update");
      // The reader's rules again, now under the locks.
      const open = await tx
        .select({ id: approvalRequest.id })
        .from(approvalRequest)
        .where(
          and(
            eq(approvalRequest.candidateId, candidateId),
            inArray(approvalRequest.id, wanted),
            notReveal,
            waiting,
            notEdited,
          ),
        );
      const stillWaiting = new Set(open.map((r) => r.id));
      const toClaim = wanted.filter((id) => stillWaiting.has(id));
      if (toClaim.length === 0) {
        span.setAttribute("northstar.push.claimed", 0);
        return [];
      }
      const rows = await tx
        .insert(pushNotification)
        .values(toClaim.map((id) => ({ candidateId, itemKey: approvalNotifyKey(id) })))
        .onConflictDoNothing({ target: [pushNotification.candidateId, pushNotification.itemKey] })
        .returning({ id: pushNotification.id, itemKey: pushNotification.itemKey });
      const byKey = new Map(rows.map((r) => [r.itemKey, r.id]));
      const claimed = toClaim.flatMap((requestId) => {
        const notificationId = byKey.get(approvalNotifyKey(requestId));
        return notificationId ? [{ notificationId, requestId }] : [];
      });
      span.setAttribute("northstar.push.claimed", claimed.length);
      return claimed;
    }),
  );
}

// A caller's claims don't name the requests they were taken for, or were already recorded in part:
// a bug in the caller, never recorded on the wrong request.
export class ApprovalClaimMismatch extends Error {
  override readonly name = "ApprovalClaimMismatch";
}

const RESULT_WORDS = {
  one: {
    sent: "Sent you a notification: a request is waiting for your approval",
    failed: "Couldn't deliver a notification about a request waiting for your approval",
  },
  more: {
    sent: "Sent you a notification: more requests are waiting for your approval",
    failed: "Couldn't deliver a notification about more requests waiting for your approval",
  },
} as const;

// What one push came to, recorded once for every claim it covered: a request's own push covers
// its one claim; an overflow push covers each request it counted. One event per push, never one
// per covered request, so an overflow of 40 is one feed line: `push.sent` when at least one
// browser took it, else `push.not_delivered`. A repeat stores nothing. Each claim must be this
// candidate's claim for the request it is paired with (its item key), and a set already recorded
// in part is refused (ApprovalClaimMismatch), so no feed line lands on the wrong request.
export async function recordApprovalPushResult(
  db: Db,
  input: {
    candidateId: CandidateId;
    // The claims, in the order they were taken, each with its request.
    covered: ReadonlyArray<{ notificationId: string; requestId: string }>;
    // True for the overflow push ("N more waiting"), false for a request's own push.
    overflow: boolean;
  } & PushCounts,
): Promise<{ recorded: boolean }> {
  const outcome = input.sent > 0 ? "sent" : "failed";
  const [first] = input.covered;
  if (!first) return { recorded: false };
  const words = input.overflow ? RESULT_WORDS.more : RESULT_WORDS.one;
  return inSpan(
    "db.push.approval_result",
    { "northstar.push.outcome": outcome, "northstar.push.covered": input.covered.length },
    (span) =>
      db.transaction(async (tx) => {
        const ids = input.covered.map((c) => c.notificationId);
        const claims = await tx
          .select({ id: pushNotification.id, itemKey: pushNotification.itemKey })
          .from(pushNotification)
          .where(
            and(
              eq(pushNotification.candidateId, input.candidateId),
              inArray(pushNotification.id, ids),
            ),
          );
        const keyOf = new Map(claims.map((c) => [c.id, c.itemKey]));
        if (
          new Set(ids).size !== ids.length ||
          input.covered.some((c) => keyOf.get(c.notificationId) !== approvalNotifyKey(c.requestId))
        ) {
          throw new ApprovalClaimMismatch("claims don't match their requests");
        }
        const rows = await tx
          .insert(pushNotificationResult)
          .values(
            input.covered.map((c) => ({
              candidateId: input.candidateId,
              notificationId: c.notificationId,
              outcome,
              sentCount: input.sent,
              goneCount: input.gone,
              rejectedCount: input.rejected,
            })),
          )
          .onConflictDoNothing({ target: pushNotificationResult.notificationId })
          .returning({ createdAt: pushNotificationResult.createdAt });
        const [row] = rows;
        if (!row) return { recorded: false };
        // Some claims recorded already, some not: refused, and the transaction rolls back.
        if (rows.length !== input.covered.length) {
          throw new ApprovalClaimMismatch("claims already recorded in part");
        }
        await appendEvent(tx, span, {
          candidateId: input.candidateId,
          // A request's own push is on that request; an overflow push on Paul's own aggregate,
          // since it names no one request.
          aggregate: input.overflow
            ? `candidate:${input.candidateId}`
            : `approval:${first.requestId}`,
          type: outcome === "sent" ? "push.sent" : "push.not_delivered",
          actor: "system",
          // Fixed words only (db.md): the feed shows this line as it is.
          reason: words[outcome],
          payload: {
            notificationId: first.notificationId,
            requests: input.covered.length,
            sent: input.sent,
            gone: input.gone,
            rejected: input.rejected,
          },
          // Keyed by the first claim, as recordPushResult keys a single one.
          idempotencyKey: `push_notification:${first.notificationId}:result`,
          at: row.createdAt,
        });
        return { recorded: true };
      }),
  );
}
