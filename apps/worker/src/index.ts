// Public entry of @northstar/worker (NS-157): the domain task queues, the Apply Gateway activity
// and the submission workflow's plain types. Workflow code itself is not exported here: it runs
// only inside Temporal's sandbox, loaded from src/workflows/index.ts by the worker (follow-up).
export {
  type ApplyActivities,
  createApplyActivities,
  type LoadPackage,
  type SubmitArgs,
} from "./activities/apply.js";
export {
  createEndingActivities,
  type EndingActivities,
  type EndingArgs,
} from "./activities/ending.js";
export {
  createSweepActivities,
  type SweepActivities,
} from "./activities/sweep.js";
// Starting and signalling the workflows (NS-225 slice 2), for the callers that file packages and
// relay the Gate's decisions.
export {
  ensureStaleSweep,
  type SignalError,
  type StartError,
  SWEEP_WORKFLOW_ID,
  signalApproval,
  signalWithdrawn,
  startSubmission,
  submissionWorkflowId,
  type TemporalPort,
  temporalPort,
} from "./client.js";
// Bounded concurrency per pool (NS-219), for the worker process (#230).
export { loadPoolLimits, type PoolLimits, type PoolQueue, workerOptions } from "./pools.js";
export { APPLY_BROWSER_QUEUE, PIPELINE_QUEUE } from "./queues.js";
export { type Decision, decide, MAX_WAITS, WAIT_REFUSALS } from "./workflows/decide.js";
export { endingKey, endingReason, type SubmissionEnding } from "./workflows/ending.js";
export type { SubmissionInput } from "./workflows/submission.js";
export type { SweepInput } from "./workflows/sweep.js";
export { failureKey, planSweep, type SweepPlan } from "./workflows/sweep-plan.js";
export {
  NOT_APPROVED,
  SUBMIT_ATTEMPTS,
  type SubmissionResult,
  type SubmitStep,
} from "./workflows/types.js";
