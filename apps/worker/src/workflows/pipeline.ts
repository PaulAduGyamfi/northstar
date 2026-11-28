import {
  ActivityFailure,
  ApplicationFailure,
  isCancellation,
  proxyActivities,
  type RetryPolicy,
  workflowInfo,
} from "@temporalio/workflow";
import type { PipelineActivities } from "../activities/pipeline.js";
import { PIPELINE_QUEUE } from "../queues.js";
import { type PipelineInput, type PipelineResult, pipelineInputProblem } from "./pipeline-plan.js";
import { PIPELINE_ATTEMPTS, runPipeline } from "./pipeline-run.js";

// One queued application through the job pipeline (NS-280 slice 2, ADR-0001, ADR-0023): tailor the
// resume, read the Greenhouse form, prepare and file the package with the Approval Gate, then start
// that round's submission workflow, which waits for the Gate's decision as a signal. Paul being
// needed (a missing setting, answer or file) is preparePackage's visible `package.needs_human`; any
// other stop is a dead letter and a failed run. Ids only in history (NS-242). Deterministic:
// activities only; the step order is plain code (runPipeline).

export { PIPELINE_ATTEMPTS };

const nonRetryableErrorTypes = ["InvalidInput"];

// Each step's retries; maximumAttempts comes from PIPELINE_ATTEMPTS, so a letter's count matches.
const retry = (
  step: keyof typeof PIPELINE_ATTEMPTS,
  initialInterval: RetryPolicy["initialInterval"],
  max: RetryPolicy["maximumInterval"],
): RetryPolicy => ({
  initialInterval,
  backoffCoefficient: 2,
  maximumInterval: max,
  maximumAttempts: PIPELINE_ATTEMPTS[step],
  nonRetryableErrorTypes,
});

// Tailoring renders and measures the resume as a PDF.
const { tailorResume } = proxyActivities<PipelineActivities>({
  taskQueue: PIPELINE_QUEUE,
  startToCloseTimeout: "2 minutes",
  retry: retry("tailor", "10 seconds", "2 minutes"),
});

// The safe fetcher's own limit is 15 s; a store and the guard's reads on top.
const { readJobForm } = proxyActivities<PipelineActivities>({
  taskQueue: PIPELINE_QUEUE,
  startToCloseTimeout: "1 minute",
  retry: retry("form", "1 minute", "15 minutes"),
});

// Database work: reads, the Gate request and two status moves.
const { preparePackage } = proxyActivities<PipelineActivities>({
  taskQueue: PIPELINE_QUEUE,
  startToCloseTimeout: "2 minutes",
  retry: retry("prepare", "10 seconds", "2 minutes"),
});

// One call to Temporal through the worker's own client.
const { startSubmission } = proxyActivities<PipelineActivities>({
  taskQueue: PIPELINE_QUEUE,
  startToCloseTimeout: "1 minute",
  retry: retry("start", "10 seconds", "2 minutes"),
});

// The dead letter must land even through a database outage: retried until the database is back,
// at most 5 minutes apart (as the submission's ending is).
const { recordPipelineEnding } = proxyActivities<PipelineActivities>({
  taskQueue: PIPELINE_QUEUE,
  startToCloseTimeout: "1 minute",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "5 minutes",
    nonRetryableErrorTypes,
  },
});

export async function jobPipelineWorkflow(input: PipelineInput): Promise<PipelineResult> {
  const problem = pipelineInputProblem(input);
  if (problem !== null) throw ApplicationFailure.nonRetryable(problem, "InvalidInput");
  // Exactly the two ids: nothing else reaches an activity's arguments.
  const args = { candidateId: input.candidateId, applicationId: input.applicationId };
  return runPipeline({
    tailor: () => tailorResume(args),
    form: () => readJobForm(args),
    prepare: () => preparePackage(args),
    start: (packageSha256) => startSubmission({ ...args, packageSha256 }),
    letter: (reasonCode, attempts) =>
      recordPipelineEnding({ ...args, runId: workflowInfo().runId, reasonCode, attempts }),
    failureOf: (error) => {
      if (isCancellation(error)) return "cancelled";
      return error instanceof ActivityFailure && error.retryState === "MAXIMUM_ATTEMPTS_REACHED"
        ? "exhausted"
        : "failed";
    },
    // A refusal (the Gate's or a status move's) fails the run visibly after its letter.
    stop: (reasonCode) => {
      throw ApplicationFailure.nonRetryable(reasonCode, "PipelineStopped");
    },
  });
}
