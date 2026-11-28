import {
  type Client,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from "@temporalio/client";
import { describe, expect, it } from "vitest";
import {
  ensureHandoffNotifier,
  ensureJobPipelineStarter,
  ensureSignalRelay,
  ensureStaleSweep,
  isNotFound,
  NOTIFY_WORKFLOW_ID,
  RELAY_WORKFLOW_ID,
  roundWaiting,
  SWEEP_WORKFLOW_ID,
  signalApproval,
  signalWithdrawn,
  startJobPipeline,
  startSubmission,
  type TemporalPort,
  temporalPort,
} from "./client.js";

// Starting and signalling the worker's workflows (NS-225 slice 2), on a fake Temporal, and the
// port's binding to Temporal's Client with its real error classes.

const CANDIDATE = "00000000-0000-4000-8000-0000000000c1";
const APP = "00000000-0000-4000-8000-0000000000a1";
const DECISION = "00000000-0000-4000-8000-0000000000d1";
const SHA = "b".repeat(64);
const SHA2 = "c".repeat(64);
const input = { candidateId: CANDIDATE, applicationId: APP, packageSha256: SHA };
const round = { applicationId: APP, packageSha256: SHA };
const ID = `submission:${APP}:${SHA}`;

// A Temporal that remembers every workflow id it ran, like REJECT_DUPLICATE within retention.
function fakeTemporal() {
  const starts: unknown[] = [];
  const signals: unknown[] = [];
  const ran = new Set<string>();
  const running = new Set<string>();
  const port: TemporalPort = {
    async start(workflowType, options) {
      starts.push({ workflowType, ...options });
      if (options.reuse === "existing") {
        running.add(options.workflowId);
        return { started: true };
      }
      if (ran.has(options.workflowId)) return { started: false };
      ran.add(options.workflowId);
      running.add(options.workflowId);
      return { started: true };
    },
    async signal(workflowId, signal, args) {
      if (!running.has(workflowId)) return { delivered: false };
      signals.push({ workflowId, signal, args });
      return { delivered: true };
    },
    async waiting(workflowId) {
      return running.has(workflowId);
    },
  };
  return { port, starts, signals, end: (id: string) => running.delete(id) };
}

describe("startJobPipeline (NS-280 slice 2)", () => {
  const pipelineInput = { candidateId: CANDIDATE, applicationId: APP };

  it("starts one pipeline run per application, round and day with exactly its two ids, and a second start starts nothing", async () => {
    const t = fakeTemporal();
    const at = { round: 0, day: "2026-11-28" };
    const first = await startJobPipeline(t.port, pipelineInput, at);
    const again = await startJobPipeline(t.port, pipelineInput, at);
    expect([first, again, t.starts]).toEqual([
      { ok: true, value: { workflowId: `pipeline:${APP}:0:2026-11-28` } },
      { ok: false, error: { kind: "AlreadyStarted" } },
      [
        {
          workflowType: "jobPipelineWorkflow",
          workflowId: `pipeline:${APP}:0:2026-11-28`,
          args: [pipelineInput],
          reuse: "reject",
        },
        {
          workflowType: "jobPipelineWorkflow",
          workflowId: `pipeline:${APP}:0:2026-11-28`,
          args: [pipelineInput],
          reuse: "reject",
        },
      ],
    ]);
  });

  it("refuses an input with any other field, starting nothing", async () => {
    const t = fakeTemporal();
    const result = await startJobPipeline(
      t.port,
      { ...pipelineInput, email: "someone@example.com" } as typeof pipelineInput,
      { round: 0, day: "2026-11-28" },
    );
    expect([result, t.starts]).toEqual([
      { ok: false, error: { kind: "InvalidInput", problem: "unexpected input field: email" } },
      [],
    ]);
  });
});

describe("startJobPipeline's round and day (NS-280 slice 3)", () => {
  const pipelineInput = { candidateId: CANDIDATE, applicationId: APP };

  it("gives a later round and a later day their own runs, and refuses a bad round or day", async () => {
    const t = fakeTemporal();
    const results = [
      await startJobPipeline(t.port, pipelineInput, { round: 0, day: "2026-11-28" }),
      await startJobPipeline(t.port, pipelineInput, { round: 1, day: "2026-11-28" }),
      await startJobPipeline(t.port, pipelineInput, { round: 1, day: "2026-11-29" }),
      await startJobPipeline(t.port, pipelineInput, { round: -1, day: "2026-11-29" }),
      await startJobPipeline(t.port, pipelineInput, { round: 0, day: "28/11/2026" }),
    ];
    expect([results.map((r) => r.ok), t.starts.length]).toEqual([
      [true, true, true, false, false],
      3,
    ]);
  });
});

describe("ensureJobPipelineStarter (NS-280 slice 3)", () => {
  it("starts the one starter, keeping a running one", async () => {
    const t = fakeTemporal();
    await ensureJobPipelineStarter(t.port, { candidateIds: [CANDIDATE] });
    expect(t.starts).toEqual([
      {
        workflowType: "jobPipelineStarterWorkflow",
        workflowId: "job-pipeline-starter",
        args: [{ candidateIds: [CANDIDATE] }],
        reuse: "existing",
      },
    ]);
  });
});

describe("startSubmission", () => {
  it("starts the package round's workflow with ids and the hash only", async () => {
    const t = fakeTemporal();
    expect(await startSubmission(t.port, input)).toEqual({ ok: true, value: { workflowId: ID } });
    expect(t.starts).toEqual([
      { workflowType: "submissionWorkflow", workflowId: ID, args: [input], reuse: "reject" },
    ]);
  });

  it("starting the same round twice runs one workflow, even after the first one ended", async () => {
    const t = fakeTemporal();
    await startSubmission(t.port, input);
    const again = await startSubmission(t.port, input);
    t.end(ID);
    const later = await startSubmission(t.port, input);
    expect([again, later]).toEqual([
      { ok: false, error: { kind: "AlreadyStarted" } },
      { ok: false, error: { kind: "AlreadyStarted" } },
    ]);
  });

  it("gives a new package round (after a rejection) its own workflow", async () => {
    const t = fakeTemporal();
    await startSubmission(t.port, input);
    t.end(ID);
    expect(await startSubmission(t.port, { ...input, packageSha256: SHA2 })).toEqual({
      ok: true,
      value: { workflowId: `submission:${APP}:${SHA2}` },
    });
  });

  it("refuses an input carrying a package field, starting nothing", async () => {
    const t = fakeTemporal();
    const result = await startSubmission(t.port, {
      ...input,
      package: { applicationId: APP },
    } as never);
    expect([result, t.starts]).toEqual([
      { ok: false, error: { kind: "InvalidInput", problem: "unexpected input field: package" } },
      [],
    ]);
  });
});

describe("signals", () => {
  it("sends the Gate's decision id to the round's running workflow", async () => {
    const t = fakeTemporal();
    await startSubmission(t.port, input);
    expect(await signalApproval(t.port, round, DECISION)).toEqual({
      ok: true,
      value: { workflowId: ID },
    });
    expect(t.signals).toEqual([
      { workflowId: ID, signal: "approval", args: [{ decisionId: DECISION }] },
    ]);
  });

  it("sends a withdrawal with no payload", async () => {
    const t = fakeTemporal();
    await startSubmission(t.port, input);
    await signalWithdrawn(t.port, round);
    expect(t.signals).toEqual([{ workflowId: ID, signal: "withdrawn", args: [] }]);
  });

  it("never sends a new round's approval to an older round's workflow", async () => {
    const t = fakeTemporal();
    await startSubmission(t.port, input);
    expect(
      await signalApproval(t.port, { applicationId: APP, packageSha256: SHA2 }, DECISION),
    ).toEqual({ ok: false, error: { kind: "NotRunning" } });
    expect(t.signals).toEqual([]);
  });

  it("refuses ids and hashes out of shape, sending nothing", async () => {
    const t = fakeTemporal();
    await startSubmission(t.port, input);
    expect([
      await signalApproval(t.port, round, "decision-1"),
      await signalWithdrawn(t.port, { ...round, applicationId: "nope" }),
      await signalWithdrawn(t.port, { ...round, packageSha256: "B".repeat(64) }),
      t.signals,
    ]).toEqual([
      { ok: false, error: { kind: "InvalidInput", problem: "decisionId is not a uuid" } },
      { ok: false, error: { kind: "InvalidInput", problem: "applicationId is not a uuid" } },
      { ok: false, error: { kind: "InvalidInput", problem: "packageSha256 is not a sha-256" } },
      [],
    ]);
  });
});

describe("ensureStaleSweep", () => {
  it("starts the one sweep, or keeps the running one, under its fixed id", async () => {
    const t = fakeTemporal();
    await ensureStaleSweep(t.port, { candidateIds: [CANDIDATE] });
    expect(t.starts).toEqual([
      {
        workflowType: "staleClaimSweepWorkflow",
        workflowId: SWEEP_WORKFLOW_ID,
        args: [{ candidateIds: [CANDIDATE] }],
        reuse: "existing",
      },
    ]);
  });

  it("refuses a candidate id that isn't a uuid", async () => {
    const t = fakeTemporal();
    await expect(ensureStaleSweep(t.port, { candidateIds: ["nope"] })).rejects.toThrow(
      "candidateIds: every id must be a uuid",
    );
  });
});

describe("ensureSignalRelay", () => {
  it("starts the one relay with the candidate ids, keeping a running one", async () => {
    const t = fakeTemporal();
    await ensureSignalRelay(t.port, { candidateIds: [CANDIDATE] });
    expect(t.starts).toEqual([
      {
        workflowType: "packageSignalRelayWorkflow",
        workflowId: RELAY_WORKFLOW_ID,
        args: [{ candidateIds: [CANDIDATE] }],
        reuse: "existing",
      },
    ]);
  });

  it("refuses a candidate id that isn't a uuid", async () => {
    const t = fakeTemporal();
    await expect(ensureSignalRelay(t.port, { candidateIds: ["nope"] })).rejects.toThrow(
      "candidateIds: every id must be a uuid",
    );
  });
});

describe("ensureHandoffNotifier (NS-193 slice 3)", () => {
  it("starts the one notifier with the candidate ids, keeping a running one", async () => {
    const t = fakeTemporal();
    await ensureHandoffNotifier(t.port, { candidateIds: [CANDIDATE] });
    expect(t.starts).toEqual([
      {
        workflowType: "handoffNotifyWorkflow",
        workflowId: NOTIFY_WORKFLOW_ID,
        args: [{ candidateIds: [CANDIDATE] }],
        reuse: "existing",
      },
    ]);
  });

  it("refuses a candidate id that isn't a uuid", async () => {
    const t = fakeTemporal();
    await expect(ensureHandoffNotifier(t.port, { candidateIds: ["nope"] })).rejects.toThrow(
      "candidateIds: every id must be a uuid",
    );
  });
});

describe("roundWaiting", () => {
  it("asks about the round's own workflow id", async () => {
    const t = fakeTemporal();
    await startSubmission(t.port, input);
    expect([
      await roundWaiting(t.port, round),
      await roundWaiting(t.port, { ...round, packageSha256: SHA2 }),
    ]).toEqual([true, false]);
  });
});

// The binding to Temporal's Client: the policies, the queue, and which errors mean "not now".
function fakeClient(behaviour: {
  start?: () => unknown;
  signal?: () => unknown;
  describe?: () => unknown;
  status?: string;
  waiting?: boolean;
}) {
  const calls: unknown[] = [];
  const client = {
    workflow: {
      start: async (type: string, options: unknown) => {
        calls.push({ type, options });
        behaviour.start?.();
      },
      getHandle: (id: string) => ({
        signal: async (name: string, ...args: unknown[]) => {
          calls.push({ id, name, args });
          behaviour.signal?.();
        },
        describe: async () => {
          calls.push({ id, describe: true });
          behaviour.describe?.();
          return { status: { name: behaviour.status ?? "RUNNING" } };
        },
        query: async (name: string) => {
          calls.push({ id, query: name });
          return behaviour.waiting ?? true;
        },
      }),
    },
  } as unknown as Client;
  return { port: temporalPort(client), calls };
}

describe("temporalPort", () => {
  it("starts a submission on the pipeline queue, refusing a reused id and any running one", async () => {
    const c = fakeClient({});
    expect(
      await c.port.start("submissionWorkflow", { workflowId: ID, args: [], reuse: "reject" }),
    ).toEqual({ started: true });
    expect(c.calls).toEqual([
      {
        type: "submissionWorkflow",
        options: {
          taskQueue: "pipeline",
          workflowId: ID,
          args: [],
          workflowIdReusePolicy: "REJECT_DUPLICATE",
          workflowIdConflictPolicy: "FAIL",
        },
      },
    ]);
  });

  it("keeps a running sweep instead of failing", async () => {
    const c = fakeClient({});
    await c.port.start("staleClaimSweepWorkflow", {
      workflowId: SWEEP_WORKFLOW_ID,
      args: [],
      reuse: "existing",
    });
    expect(c.calls).toEqual([
      {
        type: "staleClaimSweepWorkflow",
        options: {
          taskQueue: "pipeline",
          workflowId: SWEEP_WORKFLOW_ID,
          args: [],
          workflowIdConflictPolicy: "USE_EXISTING",
        },
      },
    ]);
  });

  it("reads Temporal's already-started error as nothing started", async () => {
    const c = fakeClient({
      start: () => {
        throw new WorkflowExecutionAlreadyStartedError("exists", ID, "submissionWorkflow");
      },
    });
    expect(
      await c.port.start("submissionWorkflow", { workflowId: ID, args: [], reuse: "reject" }),
    ).toEqual({ started: false });
  });

  it("reads Temporal's not-found error as no running workflow", async () => {
    const c = fakeClient({
      signal: () => {
        throw new WorkflowNotFoundError("gone", ID, undefined);
      },
    });
    expect(await c.port.signal(ID, "approval", [{ decisionId: DECISION }])).toEqual({
      delivered: false,
    });
  });

  it("lets any other error through", async () => {
    const boom = new Error("connection refused");
    const c = fakeClient({
      start: () => {
        throw boom;
      },
      signal: () => {
        throw boom;
      },
    });
    await expect(
      c.port.start("submissionWorkflow", { workflowId: ID, args: [], reuse: "reject" }),
    ).rejects.toBe(boom);
    await expect(c.port.signal(ID, "withdrawn", [])).rejects.toBe(boom);
  });

  it("asks a running workflow's waiting query", async () => {
    const c = fakeClient({ waiting: false });
    expect(await c.port.waiting(ID)).toBe(false);
    expect(c.calls).toEqual([
      { id: ID, describe: true },
      { id: ID, query: "waiting" },
    ]);
  });

  it("never queries a closed workflow, and reads not found as not waiting", async () => {
    const closed = fakeClient({ status: "COMPLETED" });
    const missing = fakeClient({
      describe: () => {
        throw new WorkflowNotFoundError("gone", ID, undefined);
      },
    });
    expect([await closed.port.waiting(ID), await missing.port.waiting(ID)]).toEqual([false, false]);
    expect(closed.calls).toEqual([{ id: ID, describe: true }]);
  });

  it("lets any other describe error through", async () => {
    const boom = new Error("connection refused");
    const c = fakeClient({
      describe: () => {
        throw boom;
      },
    });
    await expect(c.port.waiting(ID)).rejects.toBe(boom);
  });
});

describe("isNotFound", () => {
  it("reads Temporal's not-found error and a raw or wrapped gRPC NOT_FOUND as no such workflow", () => {
    expect([
      isNotFound(new WorkflowNotFoundError("gone", ID, undefined)),
      isNotFound(Object.assign(new Error("not found"), { code: 5 })),
      isNotFound(new Error("wrapped", { cause: { code: 5 } })),
    ]).toEqual([true, true, true]);
  });

  it("reads any other error, or another gRPC code, as a real failure", () => {
    expect([
      isNotFound(new Error("connection refused")),
      isNotFound(Object.assign(new Error("unavailable"), { code: 14 })),
      isNotFound(null),
    ]).toEqual([false, false, false]);
  });
});
