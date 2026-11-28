import { fileURLToPath } from "node:url";
import { Context } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SubmitArgs } from "./activities/apply.js";
import { submissionWorkflowId, temporalPort } from "./client.js";
import { APPLY_BROWSER_QUEUE, PIPELINE_QUEUE } from "./queues.js";
import type { ProbeActivities } from "./test/not-found-probe.js";
import type { SubmissionInput } from "./workflows/submission.js";
import type { SubmissionResult, SubmitStep } from "./workflows/types.js";

// The submission workflow against a real Temporal server (NS-224, #229, #108's "done when"):
// Temporal's time-skipping test server, which @temporalio/testing downloads from
// temporal.download (Paul allowed the host). The workflow is the real bundle; the activities
// are fakes under the real names, so no database, Gate or browser is involved. The fake gateway
// keeps a claim ledger in memory keyed like the Apply Gateway's (application and package), and
// its one submission is the side effect counted.

const CANDIDATE = "00000000-0000-4000-8000-000000000001";
const DECISION = "00000000-0000-4000-8000-0000000000d1";
const SHA = "ab".repeat(32);
// A fresh application per test, so each gets its own workflow id and ledger key.
const application = (n: number) => `00000000-0000-4000-8000-0000000000a${n}`;
const input = (n: number): SubmissionInput => ({
  candidateId: CANDIDATE,
  applicationId: application(n),
  packageSha256: SHA,
});

// The first run downloads the test server (about 27 MB), so the limits are long.
const LONG = 120_000;

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
  bundle = await bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL("./workflows/index.ts", import.meta.url)),
    logger: quiet,
  });
}, LONG);

afterAll(async () => {
  await env?.teardown();
}, LONG);

// The fake Apply Gateway: one submission per ledger key, however often it is called.
function fakeGateway() {
  const ledger = new Map<string, string>();
  let submissions = 0;
  return {
    get submissions() {
      return submissions;
    },
    // Claims and submits once; a repeat finds the claim and answers with the same submission.
    submit(args: SubmitArgs): { step: SubmitStep; first: boolean } {
      const key = `${args.applicationId}:${args.packageSha256}`;
      const held = ledger.get(key);
      if (held !== undefined) {
        return {
          step: {
            kind: "done",
            outcome: "submitted",
            submissionId: held,
            reason: null,
            replayed: true,
          },
          first: false,
        };
      }
      submissions++;
      const id = `submission-${submissions}`;
      ledger.set(key, id);
      return {
        step: {
          kind: "done",
          outcome: "submitted",
          submissionId: id,
          reason: null,
          replayed: false,
        },
        first: true,
      };
    },
  };
}

// One worker process: the `pipeline` pool with the workflows and the ending activity, and the
// `apply-browser` pool with the given submitApplication. Endings are counted, never stored.
async function startProcess(
  submitApplication: (args: SubmitArgs) => Promise<SubmitStep>,
  endings: unknown[],
) {
  const pipeline = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: PIPELINE_QUEUE,
    workflowBundle: bundle,
    // No cached runs: every workflow task replays from the server's history, as on a new worker,
    // and no task waits on a stopped worker's sticky queue.
    maxCachedWorkflows: 0,
    activities: {
      recordSubmissionEnding: async (args: unknown) => {
        endings.push(args);
        return { status: "recorded" as const };
      },
    },
  });
  const browser = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: APPLY_BROWSER_QUEUE,
    activities: { submitApplication },
    // A stuck attempt is cancelled a second after the stop is asked for, so a stop always ends.
    shutdownGraceTime: "1 second",
  });
  return {
    // Runs both pools until `done` settles, then shuts them down (a worker stopping).
    // Both always stop before the test goes on, even when one fails, so no stale fake activity
    // takes the next test's tasks.
    async runUntil<T>(done: Promise<T>): Promise<T> {
      const both = await Promise.allSettled([pipeline.runUntil(done), browser.runUntil(done)]);
      for (const one of both) if (one.status === "rejected") throw one.reason;
      return done;
    },
  };
}

// Resolves once the run's history holds a started timer: the run is in its durable wait.
// It polls the server's state (a few real milliseconds a round, bounded by the test's limit); it
// is not a wait for time to pass, which the test server's own clock handles.
async function timerStarted(handle: { fetchHistory(): Promise<{ events?: unknown[] | null }> }) {
  for (;;) {
    const { events } = await handle.fetchHistory();
    const started = (events ?? []).some(
      (e) => (e as { timerStartedEventAttributes?: unknown }).timerStartedEventAttributes != null,
    );
    if (started) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function startApproved(n: number) {
  const handle = await env.client.workflow.start("submissionWorkflow", {
    taskQueue: PIPELINE_QUEUE,
    workflowId: submissionWorkflowId(application(n), SHA),
    args: [input(n)],
  });
  await handle.signal("approval", { decisionId: DECISION });
  return handle;
}

describe("the submission workflow on a real Temporal server", () => {
  it(
    "survives a worker restart while it waits on a durable timer, and submits once",
    async () => {
      const gateway = fakeGateway();
      const endings: unknown[] = [];
      const handle = await startApproved(1);

      // The first process: the gateway says another attempt holds the claim, so the run starts a
      // durable timer. The worker stops only once that timer is in the history.
      const first = await startProcess(
        async () => ({ kind: "refused", refusal: "InProgress", waitMs: 60_000 }),
        endings,
      );
      await first.runUntil(timerStarted(handle));

      // A new process picks the run up from its history; time skips past the wait.
      const second = await startProcess(async (args) => gateway.submit(args).step, endings);
      const result = await second.runUntil(handle.result() as Promise<SubmissionResult>);

      expect([result, gateway.submissions, endings]).toEqual([
        { kind: "submitted", submissionId: "submission-1", reason: null, replayed: false },
        1,
        [],
      ]);
    },
    LONG,
  );

  it(
    "retries an attempt whose worker died mid-submit on a new worker without submitting again",
    async () => {
      const gateway = fakeGateway();
      const endings: unknown[] = [];
      const handle = await startApproved(2);

      // The first process submits, then never answers: its worker shuts down mid-activity.
      let submitted!: () => void;
      const reached = new Promise<void>((resolve) => {
        submitted = resolve;
      });
      const first = await startProcess(async (args) => {
        gateway.submit(args);
        submitted();
        // Held until the shutdown cancels it, then failed (retryable), as a dead worker's
        // attempt never answers with a result.
        await Context.current().cancelled.catch(() => undefined);
        throw new Error("the worker stopped mid-submit");
      }, endings);
      await first.runUntil(reached);

      const second = await startProcess(async (args) => gateway.submit(args).step, endings);
      const result = await second.runUntil(handle.result() as Promise<SubmissionResult>);

      expect([result, gateway.submissions, endings]).toEqual([
        { kind: "submitted", submissionId: "submission-1", reason: null, replayed: true },
        1,
        [],
      ]);
    },
    LONG,
  );
});

describe("temporalPort on a real Temporal server (#195's leftover)", () => {
  const missing = submissionWorkflowId(application(9), SHA);

  it(
    "answers not delivered and not waiting for a workflow that doesn't exist, over the test client",
    async () => {
      const port = temporalPort(env.client);
      expect([
        await port.signal(missing, "approval", [{ decisionId: DECISION }]),
        await port.waiting(missing),
      ]).toEqual([{ delivered: false }, false]);
    },
    LONG,
  );

  it(
    "answers the same over the worker's own client, as the relay's activity uses it",
    async () => {
      const queue = "ns-224-not-found-probe";
      const activities: ProbeActivities = {
        async probeNotFound(workflowId) {
          const port = temporalPort(Context.current().client);
          const signalled = await port.signal(workflowId, "approval", [{ decisionId: DECISION }]);
          return { delivered: signalled.delivered, waiting: await port.waiting(workflowId) };
        },
      };
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: queue,
        workflowsPath: fileURLToPath(new URL("./test/not-found-probe.ts", import.meta.url)),
        activities,
        bundlerOptions: { logger: quiet },
      });
      const answer = await worker.runUntil(
        env.client.workflow.execute("notFoundProbeWorkflow", {
          taskQueue: queue,
          workflowId: "ns-224-probe",
          args: [missing],
        }),
      );
      expect(answer).toEqual({ delivered: false, waiting: false });
    },
    LONG,
  );
});

const noop = () => undefined;
const quiet = { log: noop, trace: noop, debug: noop, info: noop, warn: noop, error: noop };
