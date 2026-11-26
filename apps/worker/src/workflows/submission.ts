import {
  ActivityFailure,
  condition,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
  sleep,
} from "@temporalio/workflow";
import type { ApplyActivities } from "../activities/apply.js";
import type { EndingActivities } from "../activities/ending.js";
import { APPLY_BROWSER_QUEUE, PIPELINE_QUEUE } from "../queues.js";
import { decide, notApprovedReason } from "./decide.js";
import { endingReason, type SubmissionEnding } from "./ending.js";
import { NOT_APPROVED, SUBMIT_ATTEMPTS, type SubmissionResult } from "./types.js";

// One application submission as a durable workflow (NS-157, ADR-0001). It waits for the Gate's
// decision as a signal (never polls), then asks the Apply Gateway to submit, waiting on durable
// timers while the gateway says "not now". Deterministic: no clock, randomness or I/O here
// (.claude/rules/worker.md); the gateway call happens in the activity.

// The Gate approved the package: carries the approvalId or policyDecisionId the gateway checks.
export const approvalSignal = defineSignal<[{ decisionId: string }]>("approval");
// The request was withdrawn before approval (Paul, or a changed package).
export const withdrawnSignal = defineSignal("withdrawn");

// applicationId names the dead letter of an ending nobody else shows (NS-226).
export type SubmissionInput = { candidateId: string; applicationId: string; package: unknown };

// Kept in step with the gateway: its browser steps take at most OPEN + SUBMIT + CLOSE = 6.5
// minutes, and a claim older than 15 minutes is treated as dead, so 10 minutes sits between.
const { submitApplication } = proxyActivities<ApplyActivities>({
  taskQueue: APPLY_BROWSER_QUEUE,
  startToCloseTimeout: "10 minutes",
  retry: {
    initialInterval: "30 seconds",
    backoffCoefficient: 2,
    maximumInterval: "15 minutes",
    maximumAttempts: SUBMIT_ATTEMPTS,
    nonRetryableErrorTypes: [NOT_APPROVED],
  },
});

// The ending's dead letter must land even through a database outage, or the run would end with
// nothing visible: retried until the database is back, at most 5 minutes apart. It runs on
// `pipeline`: database work only, and the browser pool may be down.
const { recordSubmissionEnding } = proxyActivities<EndingActivities>({
  taskQueue: PIPELINE_QUEUE,
  startToCloseTimeout: "1 minute",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "5 minutes",
    nonRetryableErrorTypes: ["InvalidInput"],
  },
});

// Records an ending that only Temporal's history would show (refused, gave_up, not_approved, or
// the activity failing every attempt). Nothing for one already visible elsewhere.
async function recordEnding(
  input: SubmissionInput,
  ending: SubmissionEnding,
  attempts: number,
): Promise<void> {
  const reasonCode = endingReason(ending);
  if (reasonCode === null) return;
  await recordSubmissionEnding({
    candidateId: input.candidateId,
    applicationId: input.applicationId,
    reasonCode,
    attempts,
  });
}

export async function submissionWorkflow(input: SubmissionInput): Promise<SubmissionResult> {
  const { result, calls } = await runSubmission(input);
  // Every gateway call counts as an attempt; at least one, as the dead letter requires.
  await recordEnding(input, result, Math.max(calls, 1));
  return result;
}

// The submission itself. An activity that failed all its attempts is recorded, then rethrown so
// Temporal still shows the failure.
async function runSubmission(
  input: SubmissionInput,
): Promise<{ result: SubmissionResult; calls: number }> {
  let decisionId: string | null = null;
  let withdrawn = false;
  // The first decision wins: a second approval signal can't swap the decision id mid-run.
  setHandler(approvalSignal, ({ decisionId: id }) => {
    decisionId ??= id;
  });
  setHandler(withdrawnSignal, () => {
    withdrawn = true;
  });

  // A durable wait: costs nothing while Paul takes days to decide.
  await condition(() => decisionId !== null || withdrawn);
  if (decisionId === null) return { result: { kind: "withdrawn" }, calls: 0 };

  for (let waits = 0; ; waits++) {
    let step: Awaited<ReturnType<typeof submitApplication>>;
    try {
      step = await submitApplication({
        candidateId: input.candidateId,
        decisionId,
        package: input.package,
      });
    } catch (error) {
      const reason = error instanceof ActivityFailure ? notApprovedReason(error.cause) : null;
      if (reason !== null) return { result: { kind: "not_approved", reason }, calls: waits + 1 };
      // Stopping the workflow is not a failed submission.
      if (isCancellation(error)) throw error;
      // Retries exhausted on an unexpected error: a dead letter makes it visible, then the
      // workflow fails so it shows in Temporal too.
      await recordEnding(input, { kind: "activity_failed" }, SUBMIT_ATTEMPTS);
      throw error;
    }
    const next = decide(step, waits);
    if (next.kind === "finish") return { result: next.result, calls: waits + 1 };
    await sleep(next.ms);
  }
}
