import type { PipelineWork, recordDeadLetter } from "@northstar/db";
import { CandidateId, type Result } from "@northstar/domain";
import type { QueueResult } from "@northstar/pipeline";
import { ApplicationFailure } from "@temporalio/common";
import type { StartError } from "../client.js";
import type { WorkerConfig } from "../config.js";
import type { PipelineInput } from "../workflows/pipeline-plan.js";
import type { SubmissionInput } from "../workflows/submission.js";
import { STARTER_ATTEMPTS } from "../workflows/types.js";

// The job pipeline's starter pass (NS-280 slice 3), on the `pipeline` pool: while Paul has turned
// WORKER_JOB_PIPELINE on, it queues ready jobs in the queue band (queueReadyJobs: at most the daily
// cap, never over APPLY-007's 25), starts a pipeline run for each queued application's round (once
// a UTC day, so one Paul unblocked runs again), and starts the submission run of each open round
// (an edited package's too; once per package hash). Off, it does nothing, so a starter left
// running from earlier queues and starts nothing. Nothing here submits or approves: a submission
// run waits for the Gate's decision, and the Apply Gateway checks it, `auto_apply` and its pacing.

export type StarterPorts = {
  setting: WorkerConfig["jobPipeline"];
  queue: (candidateId: CandidateId, dailyCap: number) => Promise<QueueResult>;
  work: (candidateId: CandidateId) => Promise<PipelineWork>;
  startPipeline: (
    input: PipelineInput,
    at: { round: number; day: string },
  ) => Promise<Result<{ workflowId: string }, StartError>>;
  startSubmission: (input: SubmissionInput) => Promise<Result<{ workflowId: string }, StartError>>;
  // Today's UTC date, YYYY-MM-DD: the pipeline run's day (activities may read a clock).
  today: () => string;
  recordLetter: (letter: {
    candidateId: CandidateId;
    key: string;
  }) => ReturnType<typeof recordDeadLetter>;
};

// New pipeline runs a pass starts at most; the rest start on later passes, so a backlog doesn't
// put many tailoring and form reads on the pool at once.
export const MAX_PIPELINE_STARTS_PER_PASS = 10;

export type StartPass =
  | { on: false }
  | {
      on: true;
      queue: QueueResult;
      pipelines: { started: number; existing: number };
      submissions: { started: number; existing: number };
    };

const invalid = (what: string) => ApplicationFailure.nonRetryable(what, "InvalidInput");

function candidate(id: string): CandidateId {
  const parsed = CandidateId.safeParse(id);
  if (!parsed.success) throw invalid("candidateId is not a uuid");
  return parsed.data;
}

// An error's class name only: a database error's message quotes its parameters.
const errorName = (error: unknown): string =>
  error instanceof Error ? error.constructor.name : "Unknown";

export function createStarterActivities(ports: StarterPorts) {
  return {
    async startPipelines(args: { candidateId: string }): Promise<StartPass> {
      const candidateId = candidate(args.candidateId);
      if (!ports.setting.on) return { on: false };
      const failures: string[] = [];
      let queue: QueueResult;
      try {
        queue = await ports.queue(candidateId, ports.setting.dailyCap);
        // Starting what is already queued goes on even if queueing failed this pass.
      } catch (error) {
        failures.push(errorName(error));
        queue = { queued: 0, replayed: 0, capped: 0, missing: 0, taken: 0 };
      }
      let work: PipelineWork;
      try {
        work = await ports.work(candidateId);
      } catch (error) {
        throw ApplicationFailure.retryable(errorName(error), "StepError");
      }
      const day = ports.today();
      const pipelines = { started: 0, existing: 0 };
      for (const q of work.queued) {
        if (pipelines.started >= MAX_PIPELINE_STARTS_PER_PASS) break;
        try {
          const started = await ports.startPipeline(
            { candidateId, applicationId: q.applicationId },
            { round: q.rounds, day },
          );
          if (started.ok) pipelines.started++;
          else if (started.error.kind === "AlreadyStarted") pipelines.existing++;
          else failures.push("InvalidInput");
        } catch (error) {
          // One application's start failing doesn't stop the others.
          failures.push(errorName(error));
        }
      }
      const submissions = { started: 0, existing: 0 };
      for (const r of work.openRounds) {
        try {
          const started = await ports.startSubmission({
            candidateId,
            applicationId: r.applicationId,
            packageSha256: r.packageSha256,
          });
          if (started.ok) submissions.started++;
          else if (started.error.kind === "AlreadyStarted") submissions.existing++;
          else failures.push("InvalidInput");
        } catch (error) {
          failures.push(errorName(error));
        }
      }
      // After trying everything: the attempt fails (and is retried) with class names only.
      if (failures.length > 0) {
        throw ApplicationFailure.retryable(
          [...new Set(failures)].join(",").slice(0, 200),
          "StarterStepsFailed",
        );
      }
      return { on: true, queue, pipelines, submissions };
    },

    // A pass that failed all its attempts (RES-007): one letter per workflow run.
    async recordStarterFailure(args: { candidateId: string; key: string }): Promise<void> {
      const candidateId = candidate(args.candidateId);
      const result = await ports.recordLetter({ candidateId, key: args.key });
      if (!result.ok) throw invalid(`invalid dead letter: ${result.error.field}`);
    },
  };
}

export type StarterActivities = ReturnType<typeof createStarterActivities>;

// The letter's fields (kind, subject, code, attempts) live with the binding, kept here so the
// wiring and the tests agree.
export const starterLetter = (candidateId: CandidateId, key: string) => ({
  candidateId,
  kind: "pipeline.start" as const,
  subject: `candidate:${candidateId}`,
  reasonCode: "start_pass_failed",
  attempts: STARTER_ATTEMPTS,
  idempotencyKey: key,
});
