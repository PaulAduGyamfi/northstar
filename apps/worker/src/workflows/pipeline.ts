import {
  ActivityFailure,
  ApplicationFailure,
  isCancellation,
  proxyActivities,
  workflowInfo,
} from "@temporalio/workflow";
import type { PipelineActivities } from "../activities/pipeline.js";
import { PIPELINE_QUEUE } from "../queues.js";
import {
  type PipelineInput,
  type PipelineResult,
  type PipelineStepName,
  pipelineInputProblem,
  stepFailedCode,
} from "./pipeline-plan.js";

// One queued application through the job pipeline (NS-280 slice 2, ADR-0001, ADR-0023): tailor the
// resume, read the Greenhouse form, prepare and file the package with the Approval Gate, then start
// that round's submission workflow, which waits for the Gate's decision as a signal. Paul being
// needed (a missing setting, answer or file) is preparePackage's visible `package.needs_human`; any
// other stop is a dead letter. Ids only in history (NS-242). Deterministic: activities only.

// Attempts per step before its dead letter.
export const PIPELINE_ATTEMPTS: Record<PipelineStepName, number> = {
  tailor: 3,
  // Held back by `source:greenhouse` (Paul's switch or the breaker) or Greenhouse not answering:
  // retried for about an hour and a half (1, 2, 4, 8, 15, 15, 15 … minutes) before the letter.
  form: 10,
  prepare: 3,
  start: 5,
};

const nonRetryableErrorTypes = ["InvalidInput"];

// Database work and PDF rendering (tailoring renders and measures the resume). tailor and
// prepare take the same attempts.
const { tailorResume, preparePackage } = proxyActivities<PipelineActivities>({
  taskQueue: PIPELINE_QUEUE,
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "10 seconds",
    backoffCoefficient: 2,
    maximumInterval: "2 minutes",
    maximumAttempts: PIPELINE_ATTEMPTS.prepare,
    nonRetryableErrorTypes,
  },
});

// One call to Temporal through the worker's own client.
const { startSubmission } = proxyActivities<PipelineActivities>({
  taskQueue: PIPELINE_QUEUE,
  startToCloseTimeout: "1 minute",
  retry: {
    initialInterval: "10 seconds",
    backoffCoefficient: 2,
    maximumInterval: "2 minutes",
    maximumAttempts: PIPELINE_ATTEMPTS.start,
    nonRetryableErrorTypes,
  },
});

const { readJobForm } = proxyActivities<PipelineActivities>({
  taskQueue: PIPELINE_QUEUE,
  // The safe fetcher's own limit is 15 s; a store and the guard's reads on top.
  startToCloseTimeout: "1 minute",
  retry: {
    initialInterval: "1 minute",
    backoffCoefficient: 2,
    maximumInterval: "15 minutes",
    maximumAttempts: PIPELINE_ATTEMPTS.form,
    nonRetryableErrorTypes,
  },
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
  const letter = (reasonCode: string, attempts: number) =>
    recordPipelineEnding({ ...args, runId: workflowInfo().runId, reasonCode, attempts });

  // A step whose activity failed for good: a dead letter makes it visible, then the workflow fails
  // so Temporal shows it too. Stopping the workflow is not a failure and records nothing.
  async function step<T>(name: PipelineStepName, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (isCancellation(error)) throw error;
      const exhausted =
        error instanceof ActivityFailure && error.retryState === "MAXIMUM_ATTEMPTS_REACHED";
      await letter(stepFailedCode(name), exhausted ? PIPELINE_ATTEMPTS[name] : 1);
      throw error;
    }
  }

  // A refused tailor or an unreadable form doesn't stop the run: preparePackage then says what's
  // missing (no resume file, no form) as the visible needs-you line.
  await step("tailor", () => tailorResume(args));
  await step("form", () => readJobForm(args));
  const prepared = await step("prepare", () => preparePackage(args));
  if (prepared.kind === "needs_human") return { kind: "needs_human" };
  if (prepared.kind === "skipped") return prepared;
  if (prepared.kind === "stopped") {
    await letter(prepared.reasonCode, 1);
    return prepared;
  }
  const { packageSha256 } = prepared;
  const started = await step("start", () => startSubmission({ ...args, packageSha256 }));
  return {
    kind: started.kind === "started" ? "submission_started" : "submission_exists",
    packageSha256,
  };
}
