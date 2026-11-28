import type {
  ApprovalToNotify,
  ClaimResult,
  FreshAlertToNotify,
  HandoffToNotify,
  LivePushSubscription,
  PushCounts,
  PushSubject,
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
import { pushApprovals } from "./notify-approvals.js";

// The notifier's activities (NS-193 slice 3, ADR-0032 item 6; NS-199 item 1 slice 2; NS-204
// slice 2): one pass that pushes each new open handoff, each request newly waiting in the Queue
// and each new fresh-job alert to Paul's browsers, at most once, and the dead letter for a pass
// that kept failing (RES-007). A push only shows fixed words and opens Today or the Queue: it
// acts on nothing, and never approves.
//
// At most once: an item's claim is taken before any push goes out, so a repeated pass, a retried
// activity or a second worker sends nothing more. A claim whose result was never recorded (the
// worker died in between) is reported as a dead letter, never pushed again. A push that no
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
  // Fresh-job alerts (NS-199): the reader keeps quiet hours (never a held alert) and the window.
  freshToNotify: (candidateId: CandidateId) => Promise<FreshAlertToNotify[]>;
  claimFresh: (candidateId: CandidateId, jobId: string) => Promise<ClaimResult>;
  // Requests waiting in the Queue (NS-204): the reader leaves out reveals, policy approvals and
  // anything Paul decided, withdrew or edited.
  approvalsToNotify: (candidateId: CandidateId) => Promise<ApprovalToNotify[]>;
  claimApproval: (candidateId: CandidateId, requestId: string) => Promise<ClaimResult>;
  // The overflow push's claims, all or nothing in one transaction: the requests still waiting.
  claimApprovals: (
    candidateId: CandidateId,
    requestIds: string[],
  ) => Promise<Array<{ notificationId: string; requestId: string }>>;
  // One push's outcome, for every claim it covered (one for a request's own push).
  recordApproval: (
    candidateId: CandidateId,
    input: {
      covered: Array<{ notificationId: string; requestId: string }>;
      overflow: boolean;
    } & PushCounts,
  ) => Promise<void>;
  removeGone: (candidateId: CandidateId, subscriptionId: string) => Promise<void>;
  record: (
    candidateId: CandidateId,
    input: { notificationId: string } & PushSubject & PushCounts,
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
// A claim's key names what it was for (PUSH_ITEM_KEY_PATTERN in packages/db): the dead letter's
// subject is that entity, `apply_handoff:<id>`, `job:<id>` or `approval:<id>`.
const STALE_SUBJECT: ReadonlyArray<readonly [RegExp, string]> = [
  [/^apply_handoff:([0-9a-f-]{36}):notify$/, "apply_handoff"],
  [/^job_fresh_alert:([0-9a-f-]{36}):notify$/, "job"],
  [/^approval_request:([0-9a-f-]{36}):notify$/, "approval"],
];

function staleSubject(itemKey: string): string | null {
  for (const [pattern, prefix] of STALE_SUBJECT) {
    const id = pattern.exec(itemKey)?.[1];
    if (id) return `${prefix}:${id}`;
  }
  return null;
}

// A candidate id crosses Temporal as JSON: checked again here. Bad input never improves.
function candidate(raw: string): CandidateId {
  const parsed = CandidateId.safeParse(raw);
  if (!parsed.success)
    throw ApplicationFailure.nonRetryable("candidateId is not a uuid", "InvalidInput");
  return parsed.data;
}

// One item to push, after its claim: what to send, and how to record what it came to.
export type ClaimedItem = {
  // The claim the push's dead letter is keyed by (the first one, for an overflow push).
  notificationId: string;
  payload: PushPayload;
  record: (counts: PushCounts) => Promise<void>;
  // The dead letter's subject (`apply_handoff:<id>`, `job:<id>`, `approval:<id>` or, for an
  // overflow push, `candidate:<id>`).
  letterSubject: string;
};

// A handoff's or a fresh job's record: one claim, through recordPushResult.
const recordOne =
  (ports: NotifyPorts, candidateId: CandidateId, notificationId: string, subject: PushSubject) =>
  (counts: PushCounts) =>
    ports.record(candidateId, { notificationId, ...subject, ...counts });

// Pushes one claimed item to every browser, records it once, and reports a push no browser took.
// Answers "held" when every send was held back (the breaker opened, or the switch flipped between
// check and send), so the pass stops claiming.
async function pushClaimed(
  ports: NotifyPorts,
  send: NonNullable<NotifyPorts["send"]>,
  candidateId: CandidateId,
  subscriptions: LivePushSubscription[],
  item: ClaimedItem,
): Promise<"sent" | "undelivered" | "held"> {
  const result: PushCounts = { sent: 0, gone: 0, rejected: 0 };
  let heldBack = 0;
  for (const subscription of subscriptions) {
    try {
      const answer = await send(candidateId, subscription, item.payload);
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
      subject: item.letterSubject,
      // Held back reads apart from a push no browser took.
      reasonCode: allHeld ? "push_paused" : "not_delivered",
      key: `push:${item.notificationId}:undelivered`,
      attempts: subscriptions.length,
    });
  }
  await item.record(result);
  if (result.sent > 0) return "sent";
  return allHeld ? "held" : "undelivered";
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
    const subject = staleSubject(claim.itemKey);
    // A key of a kind this version doesn't know is never guessed into a subject.
    if (!subject) continue;
    await ports.deadLetter(candidateId, {
      subject,
      reasonCode: "outcome_unknown",
      key: `push:${claim.notificationId}:unknown`,
      attempts: 1,
    });
    counts.unknown++;
  }

  // Nothing is claimed while push is switched off or no browser listens: an item opened now is
  // still pushed once Paul turns it back on, rather than claimed and lost.
  if (!(await ports.isOn(candidateId))) return { ...counts, idle: "switched_off" };
  const subscriptions = await ports.live(candidateId);
  if (subscriptions.length === 0) return { ...counts, idle: "no_browsers" };

  // Pushes one claimed item and counts it; false when the pass must stop (every send held back).
  const pushOne = async (item: ClaimedItem): Promise<boolean> => {
    const outcome = await pushClaimed(ports, send, candidateId, subscriptions, item);
    if (outcome === "sent") counts.notified++;
    else counts.undelivered++;
    // Every send held back: stop here, so one held-back item, not every open one, uses up its
    // push this pass. The rest wait for a pass the breaker allows.
    return outcome !== "held";
  };

  // Handoffs first: they hold an application until Paul acts.
  for (const handoff of await ports.toNotify(candidateId)) {
    // Only the challenges a handoff opens for have words; anything else is never pushed.
    if (!CHALLENGES.has(handoff.reason)) continue;
    // Asked again before each claim: a switch Paul flips mid-pass stops the claiming at once.
    if (!(await ports.isOn(candidateId))) return { ...counts, idle: "switched_off" };
    const claim = await ports.claim(candidateId, handoff.handoffId);
    if (claim.kind !== "claimed") continue;
    const go = await pushOne({
      notificationId: claim.notificationId,
      payload: {
        v: 1,
        kind: "handoff",
        id: handoff.handoffId,
        ats: handoff.ats,
        reason: handoff.reason as PushChallenge,
      },
      record: recordOne(ports, candidateId, claim.notificationId, {
        handoffId: handoff.handoffId,
      }),
      letterSubject: `apply_handoff:${handoff.handoffId}`,
    });
    if (!go) return counts;
  }

  // Then requests waiting in the Queue (NS-204): a few alone, the rest in one overflow push.
  const approvals = await pushApprovals(ports, candidateId, pushOne);
  if (approvals !== "done")
    return approvals === "switched_off" ? { ...counts, idle: "switched_off" } : counts;

  // Then fresh-job alerts (NS-199): only alerts the alert pass sent (never a held one), from the
  // last hour, so quiet hours stay exactly what that pass decided.
  for (const alert of await ports.freshToNotify(candidateId)) {
    if (!(await ports.isOn(candidateId))) return { ...counts, idle: "switched_off" };
    const claim = await ports.claimFresh(candidateId, alert.jobId);
    if (claim.kind !== "claimed") continue;
    const go = await pushOne({
      notificationId: claim.notificationId,
      payload: { v: 1, kind: "fresh_job", id: alert.jobId, age: alert.age, fit: alert.fit },
      record: recordOne(ports, candidateId, claim.notificationId, { jobId: alert.jobId }),
      letterSubject: `job:${alert.jobId}`,
    });
    if (!go) return counts;
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
