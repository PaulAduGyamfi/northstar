import type {
  ClaimResult,
  HandoffToNotify,
  LivePushSubscription,
  PushCounts,
  StaleClaim,
} from "@northstar/db";
import {
  CandidateId,
  PUSH_CHALLENGES,
  type PushChallenge,
  type PushPayload,
} from "@northstar/domain";
import { PushHeldBack, PushRequestError, type PushResult } from "@northstar/gateways";
import { ApplicationFailure } from "@temporalio/common";
import { NOTIFY_ATTEMPTS } from "../workflows/types.js";

// The handoff notifier's activities (NS-193 slice 3, ADR-0032 item 6): one pass that pushes each
// new open handoff to Paul's browsers, at most once, and the dead letter for a pass that kept
// failing (RES-007). A push only shows fixed words and opens Today: it acts on nothing.
//
// At most once: the handoff's claim is taken before any push goes out, so a repeated pass, a
// retried activity or a second worker sends nothing more. A claim whose result was never recorded
// (the worker died in between) is reported as a dead letter, never pushed again. A push that no
// browser took is a dead letter too, so Paul sees it on /health.

export type NotifyPorts = {
  // Null while the PUSH_VAPID_* settings aren't set: the pass does nothing.
  send:
    | ((
        candidateId: CandidateId,
        subscription: LivePushSubscription,
        payload: PushPayload,
      ) => Promise<PushResult>)
    | null;
  isOn: (candidateId: CandidateId) => Promise<boolean>;
  live: (candidateId: CandidateId) => Promise<LivePushSubscription[]>;
  toNotify: (candidateId: CandidateId) => Promise<HandoffToNotify[]>;
  claim: (candidateId: CandidateId, handoffId: string) => Promise<ClaimResult>;
  removeGone: (candidateId: CandidateId, subscriptionId: string) => Promise<void>;
  record: (
    candidateId: CandidateId,
    input: { notificationId: string; handoffId: string } & PushCounts,
  ) => Promise<void>;
  stale: (candidateId: CandidateId) => Promise<StaleClaim[]>;
  deadLetter: (
    candidateId: CandidateId,
    letter: { subject: string; reasonCode: string; key: string; attempts: number },
  ) => Promise<void>;
};

export type NotifyCounts = {
  notified: number;
  undelivered: number;
  unknown: number;
  // Why nothing was sent this pass, if so.
  idle: "off" | "switched_off" | "no_browsers" | null;
};

const CHALLENGES: ReadonlySet<string> = new Set(PUSH_CHALLENGES);
const HANDOFF_KEY = /^apply_handoff:([0-9a-f-]{36}):notify$/;

// A candidate id crosses Temporal as JSON: checked again here. Bad input never improves.
function candidate(raw: string): CandidateId {
  const parsed = CandidateId.safeParse(raw);
  if (!parsed.success)
    throw ApplicationFailure.nonRetryable("candidateId is not a uuid", "InvalidInput");
  return parsed.data;
}

// One pass for one candidate. Counts only: ids stay out of Temporal's history.
export async function notifyPass(
  ports: NotifyPorts,
  candidateId: CandidateId,
): Promise<NotifyCounts> {
  const counts: NotifyCounts = { notified: 0, undelivered: 0, unknown: 0, idle: null };
  const send = ports.send;
  if (send === null) return { ...counts, idle: "off" };

  // Claims left without a result by a run that died: reported once each, never re-sent.
  for (const claim of await ports.stale(candidateId)) {
    const handoff = HANDOFF_KEY.exec(claim.itemKey)?.[1];
    if (!handoff) continue;
    await ports.deadLetter(candidateId, {
      subject: `apply_handoff:${handoff}`,
      reasonCode: "outcome_unknown",
      key: `push:${claim.notificationId}:unknown`,
      attempts: 1,
    });
    counts.unknown++;
  }

  // Nothing is claimed while push is switched off or no browser listens: a handoff opened now is
  // still pushed once Paul turns it back on, rather than claimed and lost.
  if (!(await ports.isOn(candidateId))) return { ...counts, idle: "switched_off" };
  const subscriptions = await ports.live(candidateId);
  if (subscriptions.length === 0) return { ...counts, idle: "no_browsers" };

  for (const handoff of await ports.toNotify(candidateId)) {
    // Only the challenges a handoff opens for have words; anything else is never pushed.
    if (!CHALLENGES.has(handoff.reason)) continue;
    // Asked again before each claim: a switch Paul flips mid-pass stops the claiming at once.
    if (!(await ports.isOn(candidateId))) return { ...counts, idle: "switched_off" };
    const claim = await ports.claim(candidateId, handoff.handoffId);
    if (claim.kind !== "claimed") continue;
    const payload: PushPayload = {
      v: 1,
      kind: "handoff",
      id: handoff.handoffId,
      ats: handoff.ats,
      reason: handoff.reason as PushChallenge,
    };
    const result: PushCounts = { sent: 0, gone: 0, rejected: 0 };
    // Sends the switch or the breaker held back: if every send was, the pass stops claiming.
    let heldBack = 0;
    for (const subscription of subscriptions) {
      try {
        const answer = await send(candidateId, subscription, payload);
        if (answer === "sent") result.sent++;
        else if (answer === "rejected") result.rejected++;
        else {
          result.gone++;
          // The push service says this browser's subscription is gone: stop pushing to it.
          await ports.removeGone(candidateId, subscription.id).catch(() => undefined);
        }
      } catch (error) {
        // A stored subscription the sender refuses counts as rejected; a held-back push or the
        // push service failing counts as not taken. Either way the claim stands: at most once.
        if (error instanceof PushRequestError) result.rejected++;
        else if (error instanceof PushHeldBack) heldBack++;
      }
    }
    const allHeld = heldBack === subscriptions.length;
    // A push no browser took is reported before its result is recorded: if the run dies in
    // between, the claim reads as stale (an outcome_unknown letter), never as silently finished.
    if (result.sent === 0) {
      await ports.deadLetter(candidateId, {
        subject: `apply_handoff:${handoff.handoffId}`,
        // Held back (the breaker opened, or the switch flipped between check and send) reads
        // apart from a push no browser took.
        reasonCode: allHeld ? "push_paused" : "not_delivered",
        key: `push:${claim.notificationId}:undelivered`,
        attempts: subscriptions.length,
      });
    }
    await ports.record(candidateId, {
      notificationId: claim.notificationId,
      handoffId: handoff.handoffId,
      ...result,
    });
    if (result.sent > 0) {
      counts.notified++;
      continue;
    }
    counts.undelivered++;
    // Every send held back: stop here, so one held-back handoff, not every open one, uses up
    // its push this pass. The rest wait for a pass the breaker allows.
    if (allHeld) return counts;
  }
  return counts;
}

export function createNotifyActivities(ports: NotifyPorts) {
  return {
    // A failure is thrown for the retry policy: a repeated pass reads and claims again, and the
    // claims keep it from sending anything twice.
    async notifyHandoffs(args: { candidateId: string }): Promise<NotifyCounts> {
      return notifyPass(ports, candidate(args.candidateId));
    },
    // Records a pass that failed all its attempts. `key` names the workflow run, so every failing
    // pass of one run stores one letter, not one a minute.
    async recordNotifyFailure(args: { candidateId: string; key: string }): Promise<void> {
      const candidateId = candidate(args.candidateId);
      await ports.deadLetter(candidateId, {
        subject: `candidate:${candidateId}`,
        reasonCode: "notify_failed",
        key: args.key,
        attempts: NOTIFY_ATTEMPTS,
      });
    },
  };
}

export type NotifyActivities = ReturnType<typeof createNotifyActivities>;
