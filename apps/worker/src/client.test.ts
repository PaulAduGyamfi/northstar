import { describe, expect, it } from "vitest";
import {
  ensureStaleSweep,
  SWEEP_WORKFLOW_ID,
  signalApproval,
  signalWithdrawn,
  startSubmission,
  type TemporalPort,
} from "./client.js";

// Starting and signalling the worker's workflows (NS-225 slice 2), on a fake Temporal.

const CANDIDATE = "00000000-0000-4000-8000-0000000000c1";
const APP = "00000000-0000-4000-8000-0000000000a1";
const DECISION = "00000000-0000-4000-8000-0000000000d1";
const SHA = "b".repeat(64);
const input = { candidateId: CANDIDATE, applicationId: APP, packageSha256: SHA };

// A Temporal that remembers every workflow id it ever ran, like REJECT_DUPLICATE.
function fakeTemporal() {
  const starts: unknown[] = [];
  const signals: unknown[] = [];
  const ran = new Set<string>();
  const running = new Set<string>();
  const port: TemporalPort = {
    async start(workflowType, options) {
      starts.push({ workflowType, ...options });
      if (options.reuse === "existing" && running.has(options.workflowId)) {
        return { started: false };
      }
      if (options.reuse === "reject" && ran.has(options.workflowId)) return { started: false };
      ran.add(options.workflowId);
      running.add(options.workflowId);
      return { started: true };
    },
    async signal(workflowId, signal, args) {
      if (!running.has(workflowId)) return { delivered: false };
      signals.push({ workflowId, signal, args });
      return { delivered: true };
    },
  };
  return { port, starts, signals, end: (id: string) => running.delete(id) };
}

describe("startSubmission", () => {
  it("starts one submission workflow per application, with ids and the hash only", async () => {
    const t = fakeTemporal();
    expect(await startSubmission(t.port, input)).toEqual({
      ok: true,
      value: { workflowId: `submission:${APP}` },
    });
    expect(t.starts).toEqual([
      {
        workflowType: "submissionWorkflow",
        workflowId: `submission:${APP}`,
        args: [input],
        reuse: "reject",
      },
    ]);
  });

  it("starting twice runs one workflow, even after the first one ended", async () => {
    const t = fakeTemporal();
    await startSubmission(t.port, input);
    const again = await startSubmission(t.port, input);
    t.end(`submission:${APP}`);
    const later = await startSubmission(t.port, input);
    expect([again, later]).toEqual([
      { ok: false, error: { kind: "AlreadyStarted" } },
      { ok: false, error: { kind: "AlreadyStarted" } },
    ]);
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
  it("sends the Gate's decision id to the application's running workflow", async () => {
    const t = fakeTemporal();
    await startSubmission(t.port, input);
    expect(await signalApproval(t.port, APP, DECISION)).toEqual({
      ok: true,
      value: { workflowId: `submission:${APP}` },
    });
    expect(t.signals).toEqual([
      { workflowId: `submission:${APP}`, signal: "approval", args: [{ decisionId: DECISION }] },
    ]);
  });

  it("sends a withdrawal with no payload", async () => {
    const t = fakeTemporal();
    await startSubmission(t.port, input);
    await signalWithdrawn(t.port, APP);
    expect(t.signals).toEqual([{ workflowId: `submission:${APP}`, signal: "withdrawn", args: [] }]);
  });

  it("says when no workflow is running for the application", async () => {
    const t = fakeTemporal();
    expect(await signalApproval(t.port, APP, DECISION)).toEqual({
      ok: false,
      error: { kind: "NotRunning" },
    });
  });

  it("refuses ids that aren't uuids, sending nothing", async () => {
    const t = fakeTemporal();
    await startSubmission(t.port, input);
    expect([
      await signalApproval(t.port, APP, "decision-1"),
      await signalWithdrawn(t.port, "nope"),
      t.signals,
    ]).toEqual([
      { ok: false, error: { kind: "InvalidInput", problem: "decisionId is not a uuid" } },
      { ok: false, error: { kind: "InvalidInput", problem: "applicationId is not a uuid" } },
      [],
    ]);
  });
});

describe("ensureStaleSweep", () => {
  it("starts the one sweep, and keeps the running one when asked again", async () => {
    const t = fakeTemporal();
    const first = await ensureStaleSweep(t.port, { candidateIds: [CANDIDATE] });
    const again = await ensureStaleSweep(t.port, { candidateIds: [CANDIDATE] });
    expect([first, again, t.starts[0]]).toEqual([
      { started: true },
      { started: false },
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
