import {
  ApplicationFailure,
  continueAsNew,
  isCancellation,
  proxyActivities,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";
import type { RelayActivities } from "../activities/relay.js";
import { PIPELINE_QUEUE } from "../queues.js";
import { planSweep, relayFailureKey } from "./sweep-plan.js";
import { RELAY_ATTEMPTS } from "./types.js";

// The Gate's package decisions, relayed to the submission workflows waiting for them (NS-213
// slice 2, #195 item 2), on a durable interval. Each pass re-reads the settled outcomes and
// signals only runs that still wait, so a missed pass or a worker that was down changes nothing.
// Deterministic: timers and activities only. On `pipeline`: database and Temporal calls only.

export type RelayInput = {
  candidateIds: string[];
  // Minutes between passes (default 1): how long an approved package waits to start at most.
  intervalMinutes?: number;
};

export const DEFAULT_RELAY_INTERVAL_MINUTES = 1;
// Passes per run before continuing as new, so the history stays small.
export const RELAY_PASSES_PER_RUN = 100;

const { relayPackageDecisions } = proxyActivities<RelayActivities>({
  taskQueue: PIPELINE_QUEUE,
  // One read and a describe, query and signal per settled round (at most 200).
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumAttempts: RELAY_ATTEMPTS,
    nonRetryableErrorTypes: ["InvalidInput"],
  },
});

// The dead letter must land even through a database outage: retried until the database is back,
// at most 5 minutes apart.
const { recordRelayFailure } = proxyActivities<RelayActivities>({
  taskQueue: PIPELINE_QUEUE,
  startToCloseTimeout: "1 minute",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "5 minutes",
    nonRetryableErrorTypes: ["InvalidInput"],
  },
});

export async function packageSignalRelayWorkflow(input: RelayInput): Promise<never> {
  const plan = planSweep(input, DEFAULT_RELAY_INTERVAL_MINUTES);
  if (!plan.ok) throw ApplicationFailure.nonRetryable(plan.problem, "InvalidInput");
  const { runId } = workflowInfo();
  for (let pass = 0; pass < RELAY_PASSES_PER_RUN; pass++) {
    for (const candidateId of plan.candidateIds) {
      try {
        await relayPackageDecisions({ candidateId });
      } catch (error) {
        // Stopping the workflow is not a failed pass.
        if (isCancellation(error)) throw error;
        // Every attempt failed: a dead letter makes it visible, and the next pass reads again.
        await recordRelayFailure({ candidateId, key: relayFailureKey(runId) });
      }
    }
    await sleep(`${plan.minutes} minutes`);
  }
  return continueAsNew<typeof packageSignalRelayWorkflow>(input);
}
