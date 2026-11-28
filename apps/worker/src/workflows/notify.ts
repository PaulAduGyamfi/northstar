import {
  ApplicationFailure,
  continueAsNew,
  isCancellation,
  proxyActivities,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";
import type { NotifyActivities } from "../activities/notify.js";
import { PIPELINE_QUEUE } from "../queues.js";
import { notifyFailureKey, planSweep } from "./sweep-plan.js";
import { NOTIFY_ATTEMPTS } from "./types.js";

// The handoff notifier (NS-193 slice 3, ADR-0032 item 6): on a durable interval, push each new
// open handoff to Paul's browsers once. Each pass re-reads what still needs a push; the claims in
// the database, not this workflow, keep a push from going out twice. Deterministic: timers and
// activities only. On `pipeline`: database and push-service calls only, no browser.

export type NotifyInput = {
  candidateIds: string[];
  // Minutes between passes (default 1): how long a new handoff waits for its push at most.
  intervalMinutes?: number;
};

export const DEFAULT_NOTIFY_INTERVAL_MINUTES = 1;
// Passes per run before continuing as new, so the history stays small.
export const NOTIFY_PASSES_PER_RUN = 100;

const { notifyHandoffs } = proxyActivities<NotifyActivities>({
  taskQueue: PIPELINE_QUEUE,
  // A read, a claim and a push per browser (10 s each) for at most 20 handoffs.
  startToCloseTimeout: "5 minutes",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumAttempts: NOTIFY_ATTEMPTS,
    nonRetryableErrorTypes: ["InvalidInput"],
  },
});

// The dead letter must land even through a database outage: retried until the database is back,
// at most 5 minutes apart.
const { recordNotifyFailure } = proxyActivities<NotifyActivities>({
  taskQueue: PIPELINE_QUEUE,
  startToCloseTimeout: "1 minute",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "5 minutes",
    nonRetryableErrorTypes: ["InvalidInput"],
  },
});

export async function handoffNotifyWorkflow(input: NotifyInput): Promise<never> {
  const plan = planSweep(input, DEFAULT_NOTIFY_INTERVAL_MINUTES);
  if (!plan.ok) throw ApplicationFailure.nonRetryable(plan.problem, "InvalidInput");
  const { runId } = workflowInfo();
  for (let pass = 0; pass < NOTIFY_PASSES_PER_RUN; pass++) {
    for (const candidateId of plan.candidateIds) {
      try {
        await notifyHandoffs({ candidateId });
      } catch (error) {
        // Stopping the workflow is not a failed pass.
        if (isCancellation(error)) throw error;
        // Every attempt failed: a dead letter makes it visible, and the next pass reads again.
        await recordNotifyFailure({ candidateId, key: notifyFailureKey(runId) });
      }
    }
    await sleep(`${plan.minutes} minutes`);
  }
  return continueAsNew<typeof handoffNotifyWorkflow>(input);
}
