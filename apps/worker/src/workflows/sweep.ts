import {
  ApplicationFailure,
  continueAsNew,
  isCancellation,
  proxyActivities,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";
import type { SweepActivities } from "../activities/sweep.js";
import { PIPELINE_QUEUE } from "../queues.js";
import { failureKey, planSweep } from "./sweep-plan.js";
import { SWEEP_ATTEMPTS } from "./types.js";

// The Apply Gateway's stale-claim sweep on a durable interval (NS-220, APPLY-007/009): a claim
// whose run died is closed as needs_human, so its ATS lane frees up without waiting for the same
// application to come round again. Deterministic: timers and activities only.
//
// It runs on `pipeline`, not `apply-browser`: a pass is database work only, and the browser pool
// may be down or busy exactly when its claims need closing.

export type SweepInput = {
  candidateIds: string[];
  // Minutes between passes (default 5).
  intervalMinutes?: number;
};

// Passes per run before continuing as new, so the history stays small.
export const PASSES_PER_RUN = 100;

const { sweepStaleClaims } = proxyActivities<SweepActivities>({
  taskQueue: PIPELINE_QUEUE,
  // A pass is a few small queries per stale claim.
  startToCloseTimeout: "1 minute",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumAttempts: SWEEP_ATTEMPTS,
    nonRetryableErrorTypes: ["InvalidInput"],
  },
});

// The dead letter must land even through a database outage, or the sweep would end with the
// failure unrecorded: retried until the database is back, at most 5 minutes apart.
const { recordSweepFailure } = proxyActivities<SweepActivities>({
  taskQueue: PIPELINE_QUEUE,
  startToCloseTimeout: "1 minute",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "5 minutes",
    nonRetryableErrorTypes: ["InvalidInput"],
  },
});

export async function staleClaimSweepWorkflow(input: SweepInput): Promise<never> {
  const plan = planSweep(input);
  if (!plan.ok) throw ApplicationFailure.nonRetryable(plan.problem, "InvalidInput");
  const { runId } = workflowInfo();
  for (let pass = 0; pass < PASSES_PER_RUN; pass++) {
    for (const candidateId of plan.candidateIds) {
      try {
        await sweepStaleClaims({ candidateId });
      } catch (error) {
        // Stopping the workflow is not a failed pass.
        if (isCancellation(error)) throw error;
        // Every attempt failed: a dead letter makes it visible, and the next pass tries again.
        await recordSweepFailure({ candidateId, key: failureKey(runId, pass) });
      }
    }
    await sleep(`${plan.minutes} minutes`);
  }
  return continueAsNew<typeof staleClaimSweepWorkflow>(input);
}
