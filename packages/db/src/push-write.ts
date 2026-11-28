import { type CandidateId, endpointAllowed } from "@northstar/domain";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import {
  type PushRemovalReason,
  pushSubscription,
  pushSubscriptionRemoval,
} from "./push-schema.js";
import { appendEvent, inSpan } from "./resilience-event.js";

// Web push subscriptions (NS-193 slice 2, ADR-0032 item 5): the only writer and reader of
// push_subscription and push_subscription_removal. Events carry the subscription's row id only:
// never its endpoint (it identifies the device) or keys.

const B64URL_POINT = /^B[A-Za-z0-9_-]{86}$/;
const B64URL_AUTH = /^[A-Za-z0-9_-]{22}$/;

export type PushSubscriptionInput = { endpoint: string; p256dh: string; auth: string };

export type LivePushSubscription = PushSubscriptionInput & { id: string };

export type SubscribeResult =
  | { ok: true; subscriptionId: string; created: boolean }
  | { ok: false; error: { kind: "InvalidSubscription"; field: "endpoint" | "p256dh" | "auth" } };

// Checks a browser's subscription the way the table's CHECKs and the sender do, naming the field.
function subscriptionProblem(input: PushSubscriptionInput): "endpoint" | "p256dh" | "auth" | null {
  if (!endpointAllowed(input.endpoint)) return "endpoint";
  if (!B64URL_POINT.test(input.p256dh)) return "p256dh";
  if (!B64URL_AUTH.test(input.auth)) return "auth";
  return null;
}

// Stores a browser's subscription for Paul. The same endpoint while it is live stores nothing and
// answers the live row (a repeated click, or the page re-sending on load); after a removal it is a
// new row.
export async function subscribePush(
  db: Db,
  candidateId: CandidateId,
  input: PushSubscriptionInput,
): Promise<SubscribeResult> {
  const field = subscriptionProblem(input);
  if (field !== null) return { ok: false, error: { kind: "InvalidSubscription", field } };
  return inSpan("db.push.subscribe", {}, (span) =>
    db.transaction(async (tx) => {
      // One subscribe per candidate at a time, so two racing clicks store one row.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`push_subscribe:${candidateId}`}))`,
      );
      const [live] = await tx
        .select({ id: pushSubscription.id })
        .from(pushSubscription)
        .leftJoin(
          pushSubscriptionRemoval,
          eq(pushSubscriptionRemoval.subscriptionId, pushSubscription.id),
        )
        .where(
          and(
            eq(pushSubscription.candidateId, candidateId),
            eq(pushSubscription.endpoint, input.endpoint),
            isNull(pushSubscriptionRemoval.id),
          ),
        );
      if (live) {
        span.setAttribute("northstar.push.created", false);
        return { ok: true, subscriptionId: live.id, created: false };
      }
      const [row] = await tx
        .insert(pushSubscription)
        .values({ candidateId, endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth })
        .returning({ id: pushSubscription.id, createdAt: pushSubscription.createdAt });
      if (!row) throw new Error("push_subscription insert returned no row");
      span.setAttribute("northstar.push.created", true);
      await appendEvent(tx, span, {
        candidateId,
        aggregate: `push_subscription:${row.id}`,
        type: "push.subscribed",
        actor: "user",
        reason: "You turned on notifications in a browser",
        payload: { subscriptionId: row.id },
        idempotencyKey: `push_subscription:${row.id}:subscribed`,
        at: row.createdAt,
      });
      return { ok: true, subscriptionId: row.id, created: true };
    }),
  );
}

export type RemoveResult = { ok: true; removed: boolean };

// Ends a subscription, once: Paul's own (`user`, by endpoint, from the browser he is in) or the
// sender's after a 404/410 (`gone`, by row id). A subscription already removed, or unknown,
// removes nothing.
export async function removePushSubscription(
  db: Db,
  candidateId: CandidateId,
  target: { endpoint: string } | { subscriptionId: string },
  reason: PushRemovalReason,
): Promise<RemoveResult> {
  return inSpan("db.push.remove", { "northstar.push.reason": reason }, (span) =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`push_subscribe:${candidateId}`}))`,
      );
      const match =
        "endpoint" in target
          ? eq(pushSubscription.endpoint, target.endpoint)
          : eq(pushSubscription.id, target.subscriptionId);
      const live = await tx
        .select({ id: pushSubscription.id })
        .from(pushSubscription)
        .leftJoin(
          pushSubscriptionRemoval,
          eq(pushSubscriptionRemoval.subscriptionId, pushSubscription.id),
        )
        .where(
          and(
            eq(pushSubscription.candidateId, candidateId),
            match,
            isNull(pushSubscriptionRemoval.id),
          ),
        );
      for (const { id } of live) {
        const [row] = await tx
          .insert(pushSubscriptionRemoval)
          .values({ candidateId, subscriptionId: id, reason })
          .returning({ createdAt: pushSubscriptionRemoval.createdAt });
        if (!row) throw new Error("push_subscription_removal insert returned no row");
        await appendEvent(tx, span, {
          candidateId,
          aggregate: `push_subscription:${id}`,
          type: "push.unsubscribed",
          actor: reason === "user" ? "user" : "system",
          reason:
            reason === "user"
              ? "You turned off notifications in a browser"
              : "A browser stopped taking notifications, so it was removed",
          payload: { subscriptionId: id, reason },
          idempotencyKey: `push_subscription:${id}:removed`,
          at: row.createdAt,
        });
      }
      span.setAttribute("northstar.push.removed", live.length);
      return { ok: true, removed: live.length > 0 };
    }),
  );
}

// Paul's live subscriptions, oldest first, with their keys: only the push notifier reads these.
export async function readLivePushSubscriptions(
  db: Db,
  candidateId: CandidateId,
): Promise<LivePushSubscription[]> {
  return db
    .select({
      id: pushSubscription.id,
      endpoint: pushSubscription.endpoint,
      p256dh: pushSubscription.p256dh,
      auth: pushSubscription.auth,
    })
    .from(pushSubscription)
    .leftJoin(
      pushSubscriptionRemoval,
      eq(pushSubscriptionRemoval.subscriptionId, pushSubscription.id),
    )
    .where(and(eq(pushSubscription.candidateId, candidateId), isNull(pushSubscriptionRemoval.id)))
    .orderBy(asc(pushSubscription.position));
}

// How many browsers have notifications on, for Today. A count only.
export async function countLivePushSubscriptions(
  db: Db,
  candidateId: CandidateId,
): Promise<number> {
  return (await readLivePushSubscriptions(db, candidateId)).length;
}
