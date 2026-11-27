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
import type { RelayInput } from "./workflows/relay.js";
import type { SubmissionInput } from "./workflows/submission.js";
import type { SweepInput } from "./workflows/sweep.js";

// Starting the worker's workflows and signalling them (NS-225 slice 2). One submission workflow
// per package round (workflow id `submission:<applicationId>:<packageSha256>`): a retried start
// for the same round starts nothing, while a new round (after Paul rejected a package, or a
// changed one was withdrawn) gets its own run. Temporal refuses a reused id only while it still
// keeps the closed run (the namespace's retention): the Apply Gateway's claim is what stops a
// second submission (RES-006), never this id. The Gate's decision reaches the run as a signal
// (ADR-0001: approvals are signals, never polled). Plain code over a narrow port, tested with a
// fake; `temporalPort` binds it to Temporal's Client.

// What this module needs from Temporal, so tests need no server.
export type TemporalPort = {
  // reject: false when a workflow with this id runs or (within retention) ran. existing: always
  // true, whether it started one or kept the running one (Temporal doesn't say which).
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
  // True only while a submission workflow with this id runs and still waits for the Gate's
  // decision (its `waiting` query, NS-213 slice 2). A closed run is never queried.
  waiting(workflowId: string): Promise<boolean>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The workflow id of one package round's submission.
export const submissionWorkflowId = (applicationId: string, packageSha256: string): string =>
  `submission:${applicationId}:${packageSha256}`;

const SHA256 = /^[0-9a-f]{64}$/;

// The one stale-claim sweep (NS-220): a fixed id, so starting it again keeps the running one.
export const SWEEP_WORKFLOW_ID = "stale-claim-sweep";

// The one package decision relay (NS-213 slice 2): a fixed id, like the sweep.
export const RELAY_WORKFLOW_ID = "package-signal-relay";

export type StartError =
  // The input would fail at the workflow's start: ids and the hash only (NS-242).
  | { kind: "InvalidInput"; problem: string }
  // This package round already has (or had) a submission workflow: nothing was started.
  | { kind: "AlreadyStarted" };

export async function startSubmission(
  port: TemporalPort,
  input: SubmissionInput,
): Promise<Result<{ workflowId: string }, StartError>> {
  const problem = inputProblem(input);
  if (problem !== null) return err({ kind: "InvalidInput", problem });
  const workflowId = submissionWorkflowId(input.applicationId, input.packageSha256);
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
  // No running submission workflow for this round (never started, or already ended).
  | { kind: "NotRunning" };

// Which package round a signal is for: the run filed for exactly this package.
export type Round = { applicationId: string; packageSha256: string };

async function signal(
  port: TemporalPort,
  round: Round,
  name: string,
  args: unknown[],
): Promise<Result<{ workflowId: string }, SignalError>> {
  if (!UUID.test(round.applicationId)) {
    return err({ kind: "InvalidInput", problem: "applicationId is not a uuid" });
  }
  if (!SHA256.test(round.packageSha256)) {
    return err({ kind: "InvalidInput", problem: "packageSha256 is not a sha-256" });
  }
  const workflowId = submissionWorkflowId(round.applicationId, round.packageSha256);
  const { delivered } = await port.signal(workflowId, name, args);
  return delivered ? ok({ workflowId }) : err({ kind: "NotRunning" });
}

// The Gate approved the package: the decision id the gateway checks again when it acts. The
// workflow keeps the first decision it gets, so a retried signal (Temporal gives each call its
// own request id) changes nothing.
export function signalApproval(
  port: TemporalPort,
  round: Round,
  decisionId: string,
): Promise<Result<{ workflowId: string }, SignalError>> {
  if (!UUID.test(decisionId)) {
    return Promise.resolve(err({ kind: "InvalidInput", problem: "decisionId is not a uuid" }));
  }
  return signal(port, round, "approval", [{ decisionId }]);
}

// The request was withdrawn, or Paul rejected the package: the round's workflow ends as
// withdrawn instead of waiting for ever. A later round gets its own workflow.
export function signalWithdrawn(
  port: TemporalPort,
  round: Round,
): Promise<Result<{ workflowId: string }, SignalError>> {
  return signal(port, round, "withdrawn", []);
}

// Makes sure the stale-claim sweep runs: starts it, or keeps the one already running (Temporal
// doesn't say which). A running sweep keeps the candidate ids it started with, across
// continue-as-new: right for one candidate (Q-02); revisit when there are more.
export async function ensureStaleSweep(port: TemporalPort, input: SweepInput): Promise<void> {
  for (const id of input.candidateIds) {
    if (!UUID.test(id)) throw new Error("candidateIds: every id must be a uuid");
  }
  await port.start("staleClaimSweepWorkflow", {
    workflowId: SWEEP_WORKFLOW_ID,
    args: [input],
    reuse: "existing",
  });
}

// Makes sure the package decision relay runs (NS-213 slice 2), like the sweep: started once, the
// running one kept, with the candidate ids it started with.
export async function ensureSignalRelay(port: TemporalPort, input: RelayInput): Promise<void> {
  for (const id of input.candidateIds) {
    if (!UUID.test(id)) throw new Error("candidateIds: every id must be a uuid");
  }
  await port.start("packageSignalRelayWorkflow", {
    workflowId: RELAY_WORKFLOW_ID,
    args: [input],
    reuse: "existing",
  });
}

// Whether a package round's submission workflow still waits for its decision.
export function roundWaiting(port: TemporalPort, round: Round): Promise<boolean> {
  return port.waiting(submissionWorkflowId(round.applicationId, round.packageSha256));
}

// gRPC's NOT_FOUND status code.
const GRPC_NOT_FOUND = 5;

// Temporal's "no such workflow". The worker's own client (Context.current().client, over its
// NativeConnection) is marked experimental, with error handling that may differ: a raw gRPC
// NOT_FOUND, or one wrapped as the cause, means the same.
export function isNotFound(error: unknown): boolean {
  if (error instanceof WorkflowNotFoundError) return true;
  const codeOf = (e: unknown): unknown =>
    typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  const cause =
    typeof error === "object" && error !== null ? (error as { cause?: unknown }).cause : undefined;
  return codeOf(error) === GRPC_NOT_FOUND || codeOf(cause) === GRPC_NOT_FOUND;
}

// The port on Temporal's Client: every workflow on the `pipeline` queue (RES-001). Calls use
// the client's own gRPC retries and the connection's timeout; no extra deadline (accepted for
// a local Temporal).
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
                // No second run for this id while Temporal keeps the closed one.
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
        if (isNotFound(error)) return { delivered: false };
        throw error;
      }
    },
    async waiting(workflowId) {
      const handle = client.workflow.getHandle(workflowId);
      try {
        // Described first: querying a closed run would make a worker replay its whole history.
        const described = await handle.describe();
        if (described.status.name !== "RUNNING") return false;
        return (await handle.query<boolean>("waiting")) === true;
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },
  };
}
