import {
  acquireCall,
  claimApprovalNotification,
  claimFreshJobNotification,
  claimHandoffNotification,
  type Db,
  isSubsystemOn,
  readApprovalsToNotify,
  readFreshAlertsToNotify,
  readHandoffsToNotify,
  readLivePushSubscriptions,
  readStalePushClaims,
  recordApprovalPushResult,
  recordCallOutcome,
  recordDeadLetter,
  recordPushResult,
  removePushSubscription,
} from "@northstar/db";
import type { CandidateId } from "@northstar/domain";
import { createPushSender, PUSH_SUBSYSTEM, type VapidConfig } from "@northstar/gateways";
import { ApplicationFailure } from "@temporalio/common";
import type { NotifyPorts } from "./activities/notify.js";

// The notifier's ports bound to the database and the push sender (NS-193 slice 3; fresh-job
// alerts since NS-199 item 1 slice 2; requests waiting in the Queue since NS-204 slice 2). The sender is built per push with the candidate's own
// stored switch and breaker (ADR-0007), so a flip on /health takes effect on the next push. No VAPID settings: no sender, and the pass does
// nothing.

export function dbNotifyPorts(db: Db, vapid: VapidConfig | null): NotifyPorts {
  const senderFor = (candidateId: CandidateId) =>
    vapid === null
      ? null
      : createPushSender({
          vapid,
          guard: {
            isOn: (subsystem) => isSubsystemOn(db, candidateId, subsystem),
            acquire: (dependency) => acquireCall(db, { candidateId, dependency }),
            report: async (dependency, outcome, probeToken) => {
              await recordCallOutcome(db, { candidateId, dependency, outcome, probeToken });
            },
          },
        });
  return {
    send:
      vapid === null
        ? null
        : async (candidateId, subscription, payload) => {
            const sender = senderFor(candidateId);
            if (sender === null) throw new Error("push is off");
            // The sender opens its own `push.send` span: the host, status and result only.
            return sender.send(subscription, payload);
          },
    isOn: (candidateId) => isSubsystemOn(db, candidateId, PUSH_SUBSYSTEM),
    live: (candidateId) => readLivePushSubscriptions(db, candidateId),
    toNotify: (candidateId) => readHandoffsToNotify(db, candidateId),
    claim: (candidateId, handoffId) => claimHandoffNotification(db, candidateId, handoffId),
    freshToNotify: (candidateId) => readFreshAlertsToNotify(db, candidateId),
    claimFresh: (candidateId, jobId) => claimFreshJobNotification(db, candidateId, jobId),
    approvalsToNotify: (candidateId) => readApprovalsToNotify(db, candidateId),
    claimApproval: (candidateId, requestId) =>
      claimApprovalNotification(db, candidateId, requestId),
    recordApproval: async (candidateId, input) => {
      await recordApprovalPushResult(db, { candidateId, ...input });
    },
    removeGone: async (candidateId, subscriptionId) => {
      await removePushSubscription(db, candidateId, { subscriptionId }, "gone");
    },
    record: async (candidateId, input) => {
      await recordPushResult(db, { candidateId, ...input });
    },
    stale: (candidateId) => readStalePushClaims(db, candidateId),
    deadLetter: async (candidateId, letter) => {
      const result = await recordDeadLetter(db, {
        candidateId,
        kind: "push.notify",
        subject: letter.subject,
        reasonCode: letter.reasonCode,
        attempts: letter.attempts,
        idempotencyKey: letter.key,
      });
      // A malformed letter is a bug in this code, not a passing fault: don't retry it.
      if (!result.ok) {
        throw ApplicationFailure.nonRetryable(
          `invalid dead letter: ${result.error.field}`,
          "InvalidInput",
        );
      }
    },
  };
}
