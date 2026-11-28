import {
  type FormStep,
  type PackageStep,
  type PipelineResult,
  type PipelineStepName,
  type StartStep,
  stepFailedCode,
  type TailorStep,
} from "./pipeline-plan.js";

// The job pipeline's step order and endings as plain code (NS-280 slice 2), like `decide` for the
// submission: the workflow binds Temporal's activities and errors to it, and tests run it on
// fakes with no server.

// Attempts per step before its dead letter (the workflow's retry policies use these).
export const PIPELINE_ATTEMPTS: Record<PipelineStepName, number> = {
  tailor: 3,
  // Held back by `source:greenhouse` (Paul's switch or the breaker) or Greenhouse failing for now:
  // retried for about an hour and a half (1, 2, 4, 8, 15, 15, 15 … minutes) before the letter.
  form: 10,
  prepare: 3,
  start: 5,
};

export type PipelineSteps = {
  tailor: () => Promise<TailorStep>;
  form: () => Promise<FormStep>;
  prepare: () => Promise<PackageStep>;
  start: (packageSha256: string) => Promise<StartStep>;
  // The run's one dead letter.
  letter: (reasonCode: string, attempts: number) => Promise<unknown>;
  // How a step's thrown error reads: the workflow was cancelled (no letter), the step's retries ran
  // out, or it failed for good at once (a non-retryable error).
  failureOf: (error: unknown) => "cancelled" | "exhausted" | "failed";
  // Fails the run visibly after a refusal's letter (the workflow throws a non-retryable failure).
  stop: (reasonCode: string) => never;
};

export async function runPipeline(steps: PipelineSteps): Promise<PipelineResult> {
  // A step whose activity failed for good: a dead letter makes it visible, then the error is
  // rethrown so Temporal shows the failure too. A cancellation records nothing.
  async function step<T>(name: PipelineStepName, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      const failure = steps.failureOf(error);
      if (failure === "cancelled") throw error;
      await steps.letter(
        stepFailedCode(name),
        failure === "exhausted" ? PIPELINE_ATTEMPTS[name] : 1,
      );
      throw error;
    }
  }

  // A refused tailor or an unreadable form doesn't stop the run: the package step then says what's
  // missing (no resume file, no form) as the visible needs-you line.
  await step("tailor", steps.tailor);
  await step("form", steps.form);
  const prepared = await step("prepare", steps.prepare);
  // Already visible: Paul's needs-you line, or nothing to do for this application.
  if (prepared.kind === "needs_human") return { kind: "needs_human" };
  if (prepared.kind === "skipped") return prepared;
  if (prepared.kind === "stopped") {
    await steps.letter(prepared.reasonCode, 1);
    return steps.stop(prepared.reasonCode);
  }
  const { packageSha256 } = prepared;
  const started = await step("start", () => steps.start(packageSha256));
  return {
    kind: started.kind === "started" ? "submission_started" : "submission_exists",
    packageSha256,
  };
}
