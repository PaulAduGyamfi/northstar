import {
  ActivityFailure,
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
} from "@temporalio/workflow";
import type { ApplyActivities } from "../activities/apply.js";
import { APPLY_BROWSER_QUEUE } from "../queues.js";
import { decide, notApprovedReason } from "./decide.js";
import { NOT_APPROVED, type SubmissionResult } from "./types.js";

// One application submission as a durable workflow (NS-157, ADR-0001). It waits for the Gate's
// decision as a signal (never polls), then asks the Apply Gateway to submit, waiting on durable
// timers while the gateway says "not now". Deterministic: no clock, randomness or I/O here
// (.claude/rules/worker.md); the gateway call happens in the activity.

// The Gate approved the package: carries the approvalId or policyDecisionId the gateway checks.
export const approvalSignal = defineSignal<[{ decisionId: string }]>("approval");
// The request was withdrawn before approval (Paul, or a changed package).
export const withdrawnSignal = defineSignal("withdrawn");

export type SubmissionInput = { candidateId: string; package: unknown };

// Kept in step with the gateway: its browser steps take at most OPEN + SUBMIT + CLOSE = 6.5
// minutes, and a claim older than 15 minutes is treated as dead, so 10 minutes sits between.
const { submitApplication } = proxyActivities<ApplyActivities>({
  taskQueue: APPLY_BROWSER_QUEUE,
  startToCloseTimeout: "10 minutes",
  retry: {
    initialInterval: "30 seconds",
    backoffCoefficient: 2,
    maximumInterval: "15 minutes",
    maximumAttempts: 5,
    nonRetryableErrorTypes: [NOT_APPROVED],
  },
});

export async function submissionWorkflow(input: SubmissionInput): Promise<SubmissionResult> {
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
  if (decisionId === null) return { kind: "withdrawn" };

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
      if (reason !== null) return { kind: "not_approved", reason };
      // Retries exhausted on an unexpected error: fail the workflow so it shows in Temporal.
      throw error;
    }
    const next = decide(step, waits);
    if (next.kind === "finish") return next.result;
    await sleep(next.ms);
  }
}
