import { err, ok, type Result } from "@northstar/domain";
import {
  type Client,
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy,
  WorkflowNotFoundError,
} from "@temporalio/client";
import { PIPELINE_QUEUE } from "./queues.js";
import { inputProblem } from "./workflows/ending.js";
import type { SubmissionInput } from "./workflows/submission.js";
import type { SweepInput } from "./workflows/sweep.js";

// Starting the worker's workflows and signalling them (NS-225 slice 2). One submission workflow
// per application, never two (workflow id `submission:<applicationId>`, a reused id refused even
// after the first run ended), so a retried start can't submit twice; the Gate's decision reaches
// it as a signal (ADR-0001: approvals are signals, never polled). Plain code over a narrow port,
// tested with a fake; `temporalPort` binds it to Temporal's Client.

// What this module needs from Temporal, so tests need no server.
export type TemporalPort = {
  // False when a workflow with this id already ran or runs (the reuse policy refused it).
  start(
    workflowType: string,
    options: {
      workflowId: string;
      args: unknown[];
      // reject: never a second run for this id; existing: an already running one is kept.
      reuse: "reject" | "existing";
    },
  ): Promise<{ started: boolean }>;
  // False when no workflow with this id is running.
  signal(workflowId: string, signal: string, args: unknown[]): Promise<{ delivered: boolean }>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The workflow id of an application's submission: the idempotency key of the run itself.
export const submissionWorkflowId = (applicationId: string): string =>
  `submission:${applicationId}`;

// The one stale-claim sweep (NS-220): a fixed id, so starting it again keeps the running one.
export const SWEEP_WORKFLOW_ID = "stale-claim-sweep";

export type StartError =
  // The input would fail at the workflow's start: ids and the hash only (NS-242).
  | { kind: "InvalidInput"; problem: string }
  // This application already has (or had) a submission workflow: nothing was started.
  | { kind: "AlreadyStarted" };

export async function startSubmission(
  port: TemporalPort,
  input: SubmissionInput,
): Promise<Result<{ workflowId: string }, StartError>> {
  const problem = inputProblem(input);
  if (problem !== null) return err({ kind: "InvalidInput", problem });
  const workflowId = submissionWorkflowId(input.applicationId);
  const { started } = await port.start("submissionWorkflow", {
    workflowId,
    // Exactly the three fields: nothing else reaches Temporal's history.
    args: [
      {
        candidateId: input.candidateId,
        applicationId: input.applicationId,
        packageSha256: input.packageSha256,
      },
    ],
    reuse: "reject",
  });
  return started ? ok({ workflowId }) : err({ kind: "AlreadyStarted" });
}

export type SignalError =
  | { kind: "InvalidInput"; problem: string }
  // No running submission workflow for this application (never started, or already ended).
  | { kind: "NotRunning" };

async function signal(
  port: TemporalPort,
  applicationId: string,
  name: string,
  args: unknown[],
): Promise<Result<{ workflowId: string }, SignalError>> {
  if (!UUID.test(applicationId)) {
    return err({ kind: "InvalidInput", problem: "applicationId is not a uuid" });
  }
  const workflowId = submissionWorkflowId(applicationId);
  const { delivered } = await port.signal(workflowId, name, args);
  return delivered ? ok({ workflowId }) : err({ kind: "NotRunning" });
}

// The Gate approved the package: the decision id the gateway checks again when it acts. The
// workflow keeps the first decision it gets.
export function signalApproval(
  port: TemporalPort,
  applicationId: string,
  decisionId: string,
): Promise<Result<{ workflowId: string }, SignalError>> {
  if (!UUID.test(decisionId)) {
    return Promise.resolve(err({ kind: "InvalidInput", problem: "decisionId is not a uuid" }));
  }
  return signal(port, applicationId, "approval", [{ decisionId }]);
}

// The request was withdrawn before approval: the workflow ends as withdrawn.
export function signalWithdrawn(
  port: TemporalPort,
  applicationId: string,
): Promise<Result<{ workflowId: string }, SignalError>> {
  return signal(port, applicationId, "withdrawn", []);
}

// Makes sure the stale-claim sweep runs: starts it, or keeps the one already running.
export async function ensureStaleSweep(
  port: TemporalPort,
  input: SweepInput,
): Promise<{ started: boolean }> {
  for (const id of input.candidateIds) {
    if (!UUID.test(id)) throw new Error("candidateIds: every id must be a uuid");
  }
  return port.start("staleClaimSweepWorkflow", {
    workflowId: SWEEP_WORKFLOW_ID,
    args: [input],
    reuse: "existing",
  });
}

// The port on Temporal's Client: every workflow on the `pipeline` queue (RES-001).
export function temporalPort(client: Client): TemporalPort {
  return {
    async start(workflowType, { workflowId, args, reuse }) {
      try {
        await client.workflow.start(workflowType, {
          taskQueue: PIPELINE_QUEUE,
          workflowId,
          args,
          ...(reuse === "reject"
            ? {
                // Never a second run for this id, even after the first ended.
                workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
                workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
              }
            : { workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING }),
        });
        return { started: true };
      } catch (error) {
        if (error instanceof WorkflowExecutionAlreadyStartedError) return { started: false };
        throw error;
      }
    },
    async signal(workflowId, name, args) {
      try {
        await client.workflow.getHandle(workflowId).signal(name, ...args);
        return { delivered: true };
      } catch (error) {
        if (error instanceof WorkflowNotFoundError) return { delivered: false };
        throw error;
      }
    },
  };
}
