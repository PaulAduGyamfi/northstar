import type {
  JobFormQuestion,
  PipelineState,
  recordDeadLetter,
  SaveJobFormResult,
} from "@northstar/db";
import { CandidateId, type Result } from "@northstar/domain";
import type { PrepareResult } from "@northstar/pipeline";
import type { PollGuard } from "@northstar/sources";
import { ApplicationFailure } from "@temporalio/common";
import type { StartError } from "../client.js";
import {
  type FormStep,
  type PackageStep,
  type PipelineInput,
  pipelineKey,
  refusalCode,
  type StartStep,
  type TailorStep,
} from "../workflows/pipeline-plan.js";
import type { SubmissionInput } from "../workflows/submission.js";

// The job pipeline's activities on the `pipeline` pool (NS-280 slice 2): for one queued
// application, tailor the resume, read the Greenhouse form, prepare and file the package with the
// Gate, then start that round's submission workflow. Each is safe to repeat: the tailor and form
// stores keep unchanged content once, preparePackage replays its Gate request, and a round's
// submission starts once. Nothing here submits: the Apply Gateway does, after the Gate, on its
// own pool. Ports keep the activities testable without a database, network or Temporal.

export type PipelinePorts = {
  state: (candidateId: CandidateId, applicationId: string) => Promise<PipelineState | null>;
  // tailorForJob on the stored profile and job (no toggles): only its kind and refusal reason.
  tailor: (
    candidateId: CandidateId,
    jobId: string,
  ) => Promise<
    { kind: "tailored"; saved: boolean } | { kind: "refused" | "bad_toggle"; reason: string }
  >;
  // The job's first Greenhouse link's board and posting, or null.
  formTarget: (
    candidateId: CandidateId,
    jobId: string,
  ) => Promise<{ board: string; postingId: string } | null>;
  // The stored `source:greenhouse` switch and breaker, as board polling uses them.
  guard: (candidateId: CandidateId) => PollGuard;
  readForm: (t: { board: string; postingId: string }) => Promise<JobFormQuestion[] | null>;
  saveForm: (
    candidateId: CandidateId,
    jobId: string,
    questions: JobFormQuestion[],
  ) => Promise<SaveJobFormResult>;
  prepare: (candidateId: CandidateId, applicationId: string) => Promise<PrepareResult>;
  start: (input: SubmissionInput) => Promise<Result<{ workflowId: string }, StartError>>;
  recordLetter: (letter: {
    candidateId: CandidateId;
    applicationId: string;
    reasonCode: string;
    attempts: number;
    idempotencyKey: string;
  }) => ReturnType<typeof recordDeadLetter>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GREENHOUSE = "source:greenhouse";

// Bad input never improves on a retry.
const invalid = (what: string) => ApplicationFailure.nonRetryable(what, "InvalidInput");

// Ids cross Temporal as JSON: checked again here rather than trusted as branded.
function ids(args: PipelineInput): { candidateId: CandidateId; applicationId: string } {
  const candidateId = CandidateId.safeParse(args.candidateId);
  if (!candidateId.success) throw invalid("candidateId is not a uuid");
  if (!UUID.test(args.applicationId)) throw invalid("applicationId is not a uuid");
  return { candidateId: candidateId.data, applicationId: args.applicationId };
}

export function createPipelineActivities(ports: PipelinePorts) {
  // The tailor and form steps only run before a round opens: once the application is
  // package_ready, a new resume or form would make the crashed round's rerun see changed inputs.
  const queuedJob = async (args: PipelineInput) => {
    const { candidateId, applicationId } = ids(args);
    const state = await ports.state(candidateId, applicationId);
    return state?.status === "queued" ? { candidateId, jobId: state.jobId } : null;
  };

  const steps = {
    async tailorResume(args: PipelineInput): Promise<TailorStep> {
      const queued = await queuedJob(args);
      if (queued === null) return { kind: "skipped" };
      const run = await ports.tailor(queued.candidateId, queued.jobId);
      // No toggles are passed, so bad_toggle can't happen; it reads as a refusal if it ever did.
      return run.kind === "tailored"
        ? { kind: "tailored", saved: run.saved }
        : { kind: "refused", reason: run.reason };
    },

    async readJobForm(args: PipelineInput): Promise<FormStep> {
      const queued = await queuedJob(args);
      if (queued === null) return { kind: "skipped" };
      const target = await ports.formTarget(queued.candidateId, queued.jobId);
      if (target === null) return { kind: "no_source" };
      const guard = ports.guard(queued.candidateId);
      // Held back by Paul's switch or the breaker: no call goes out, and the activity is retried
      // later (the workflow's retry policy), then becomes a dead letter.
      if (!(await guard.isOn(GREENHOUSE))) {
        throw ApplicationFailure.retryable("source:greenhouse is switched off", "HeldBack");
      }
      const decision = await guard.acquire(GREENHOUSE);
      if (!decision.allowed) {
        throw ApplicationFailure.retryable("source:greenhouse breaker is open", "HeldBack");
      }
      const probeToken = decision.probe ? decision.probeToken : null;
      let questions: JobFormQuestion[] | null;
      try {
        questions = await ports.readForm(target);
      } catch (error) {
        // Greenhouse didn't answer (or the safe fetcher refused): counts against its breaker.
        await guard.report(GREENHOUSE, { ok: false, error: errorName(error) }, probeToken);
        throw error;
      }
      // An answer that isn't a readable form is Greenhouse answering, not failing.
      await guard.report(GREENHOUSE, { ok: true }, probeToken);
      if (questions === null) return { kind: "unreadable" };
      const saved = await ports.saveForm(queued.candidateId, queued.jobId, questions);
      return { kind: saved.status };
    },

    async preparePackage(args: PipelineInput): Promise<PackageStep> {
      const { candidateId, applicationId } = ids(args);
      const state = await ports.state(candidateId, applicationId);
      if (state === null) return { kind: "skipped", reason: "not_found" };
      // An earlier run filed this round and stopped before starting its submission: start it.
      if (state.status === "awaiting_approval") {
        return state.packageSha256 === null
          ? { kind: "stopped", reasonCode: "stored_package_missing" }
          : { kind: "filed", packageSha256: state.packageSha256 };
      }
      const prepared = await ports.prepare(candidateId, applicationId);
      switch (prepared.kind) {
        case "filed":
          return { kind: "filed", packageSha256: prepared.packageSha256 };
        case "needs_human":
          return { kind: "needs_human" };
        case "refused":
          return { kind: "skipped", reason: prepared.reason };
        case "file_refused":
        case "move_refused":
          return { kind: "stopped", reasonCode: refusalCode(prepared.kind, prepared.reason) };
      }
    },

    async startSubmission(args: PipelineInput & { packageSha256: string }): Promise<StartStep> {
      const { candidateId, applicationId } = ids(args);
      if (!SHA256.test(args.packageSha256)) throw invalid("packageSha256 is not a sha-256");
      const started = await ports.start({
        candidateId,
        applicationId,
        packageSha256: args.packageSha256,
      });
      if (started.ok) return { kind: "started" };
      if (started.error.kind === "AlreadyStarted") return { kind: "exists" };
      throw invalid(started.error.problem);
    },

    // The run's dead letter (RES-007): one per run (pipelineKey), ids and codes only.
    async recordPipelineEnding(
      args: PipelineInput & { runId: string; reasonCode: string; attempts: number },
    ): Promise<{ status: "recorded" | "exists" }> {
      const { candidateId, applicationId } = ids(args);
      if (!UUID.test(args.runId)) throw invalid("runId is not a uuid");
      const result = await ports.recordLetter({
        candidateId,
        applicationId,
        reasonCode: args.reasonCode,
        attempts: args.attempts,
        idempotencyKey: pipelineKey(applicationId, args.runId),
      });
      // A malformed letter is a bug in this code, not a passing fault.
      if (!result.ok) throw invalid(`invalid dead letter: ${result.error.field}`);
      return { status: result.value.status };
    },
  };
  return {
    tailorResume: scrubbed(steps.tailorResume),
    readJobForm: scrubbed(steps.readJobForm),
    preparePackage: scrubbed(steps.preparePackage),
    startSubmission: scrubbed(steps.startSubmission),
    recordPipelineEnding: scrubbed(steps.recordPipelineEnding),
  };
}

// Temporal keeps an activity's failure (message, stack and cause) in its history, so a raw error
// must never leave: a database error's message quotes its parameters (Paul's resume lines,
// contact details and answers), and a fetch error names hosts and addresses. Our own
// ApplicationFailures (fixed words only) pass; anything else becomes a retryable failure that
// holds the error's class name only, with no cause.
function scrubbed<A extends unknown[], R>(
  step: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args) => {
    try {
      return await step(...args);
    } catch (error) {
      if (error instanceof ApplicationFailure) throw error;
      throw ApplicationFailure.retryable(errorName(error), "StepError");
    }
  };
}

export type PipelineActivities = ReturnType<typeof createPipelineActivities>;

// An error's class name only, never its message (it may quote a URL).
const errorName = (error: unknown): string =>
  error instanceof Error ? error.constructor.name : "Unknown";
