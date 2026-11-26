import { continueAsNew, proxyActivities, sleep, workflowInfo } from "@temporalio/workflow";
import type { SweepActivities } from "../activities/sweep.js";
import { PIPELINE_QUEUE } from "../queues.js";
import { SWEEP_ATTEMPTS } from "./types.js";

// The Apply Gateway's stale-claim sweep on a durable interval (NS-220, APPLY-007/009): a claim
// whose run died is closed as needs_human, so its ATS lane frees up without waiting for the same
// application to come round again. Deterministic: timers and activities only.

export type SweepInput = {
  candidateIds: string[];
  // Minutes between passes.
  intervalMinutes?: number;
};

export const DEFAULT_SWEEP_INTERVAL_MINUTES = 5;
// Passes per run before continuing as new, so the history stays small.
export const PASSES_PER_RUN = 100;

const { sweepStaleClaims, recordSweepFailure } = proxyActivities<SweepActivities>({
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

export async function staleClaimSweepWorkflow(input: SweepInput): Promise<never> {
  const minutes = input.intervalMinutes ?? DEFAULT_SWEEP_INTERVAL_MINUTES;
  const { runId } = workflowInfo();
  for (let pass = 0; pass < PASSES_PER_RUN; pass++) {
    for (const candidateId of input.candidateIds) {
      try {
        await sweepStaleClaims({ candidateId });
      } catch {
        // Every attempt failed: a dead letter makes it visible, and the next pass tries again.
        await recordSweepFailure({ candidateId, key: `stale_sweep:${runId}:${pass}` });
      }
    }
    await sleep(`${minutes} minutes`);
  }
  return continueAsNew<typeof staleClaimSweepWorkflow>(input);
}
