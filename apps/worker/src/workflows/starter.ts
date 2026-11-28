import {
  ApplicationFailure,
  continueAsNew,
  isCancellation,
  proxyActivities,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";
import type { StarterActivities } from "../activities/starter.js";
import { PIPELINE_QUEUE } from "../queues.js";
import { planSweep, starterFailureKey } from "./sweep-plan.js";
import { STARTER_ATTEMPTS } from "./types.js";

// The job pipeline's starter (NS-280 slice 3), on a durable interval: each pass queues ready jobs
// and starts the pipeline and submission runs that are due. Every pass reads storage again, so a
// missed pass or a worker that was down changes nothing. Deterministic: timers and activities
// only. On `pipeline`: database and Temporal calls only.

export type StarterInput = {
  candidateIds: string[];
  // Minutes between passes (default 10): how long a newly scored job waits to be queued at most.
  intervalMinutes?: number;
};

export const DEFAULT_STARTER_INTERVAL_MINUTES = 10;
// Passes per run before continuing as new, so the history stays small.
export const STARTER_PASSES_PER_RUN = 100;

const { startPipelines } = proxyActivities<StarterActivities>({
  taskQueue: PIPELINE_QUEUE,
  // Queueing (up to 50 reads and creations) and up to 110 starts on the worker's own client.
  startToCloseTimeout: "5 minutes",
  retry: {
    initialInterval: "10 seconds",
    backoffCoefficient: 2,
    maximumAttempts: STARTER_ATTEMPTS,
    nonRetryableErrorTypes: ["InvalidInput"],
  },
});

// The dead letter must land even through a database outage: retried until the database is back,
// at most 5 minutes apart.
const { recordStarterFailure } = proxyActivities<StarterActivities>({
  taskQueue: PIPELINE_QUEUE,
  startToCloseTimeout: "1 minute",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "5 minutes",
    nonRetryableErrorTypes: ["InvalidInput"],
  },
});

export async function jobPipelineStarterWorkflow(input: StarterInput): Promise<never> {
  const plan = planSweep(input, DEFAULT_STARTER_INTERVAL_MINUTES);
  if (!plan.ok) throw ApplicationFailure.nonRetryable(plan.problem, "InvalidInput");
  const { runId } = workflowInfo();
  for (let pass = 0; pass < STARTER_PASSES_PER_RUN; pass++) {
    for (const candidateId of plan.candidateIds) {
      try {
        await startPipelines({ candidateId });
      } catch (error) {
        // Stopping the workflow is not a failed pass.
        if (isCancellation(error)) throw error;
        // Every attempt failed: a dead letter makes it visible, and the next pass reads again.
        await recordStarterFailure({ candidateId, key: starterFailureKey(runId) });
      }
    }
    await sleep(`${plan.minutes} minutes`);
  }
  return continueAsNew<typeof jobPipelineStarterWorkflow>(input);
}
