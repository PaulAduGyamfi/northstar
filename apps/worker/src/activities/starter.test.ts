import type { PipelineWork } from "@northstar/db";
import { CandidateId, err, ok } from "@northstar/domain";
import { ApplicationFailure } from "@temporalio/common";
import { describe, expect, it } from "vitest";
import {
  createStarterActivities,
  MAX_PIPELINE_STARTS_PER_PASS,
  type StarterPorts,
  starterLetter,
} from "./starter.js";

// The job pipeline's starter pass (NS-280 slice 3) on fakes.

const CANDIDATE = "00000000-0000-4000-8000-0000000000c1";
const app = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const SHA = "e".repeat(64);
const QUEUED = { queued: 1, replayed: 0, capped: 0, missing: 0, taken: 0 };

function fakes(options: {
  on?: boolean;
  work?: PipelineWork;
  failStart?: string;
  existing?: string[];
}) {
  const calls: { queue: number[]; pipelines: unknown[]; submissions: unknown[] } = {
    queue: [],
    pipelines: [],
    submissions: [],
  };
  const ports: StarterPorts = {
    setting: options.on === false ? { on: false } : { on: true, dailyCap: 7 },
    queue: async (_c, cap) => {
      calls.queue.push(cap);
      return QUEUED;
    },
    work: async () =>
      options.work ?? {
        queued: [{ applicationId: app(1), rounds: 1 }],
        openRounds: [{ applicationId: app(2), packageSha256: SHA }],
      },
    startPipeline: async (input, at) => {
      if (input.applicationId === options.failStart) throw new TypeError("connect refused");
      calls.pipelines.push([input, at]);
      return options.existing?.includes(input.applicationId)
        ? err({ kind: "AlreadyStarted" })
        : ok({ workflowId: "w" });
    },
    startSubmission: async (input) => {
      calls.submissions.push(input);
      return ok({ workflowId: "s" });
    },
    today: () => "2026-11-28",
    recordLetter: async () => ok({ status: "recorded", deadLetterId: app(9) }),
  };
  return { activities: createStarterActivities(ports), calls };
}

describe("startPipelines (NS-280 slice 3)", () => {
  it("does nothing at all while the job pipeline is off", async () => {
    const { activities, calls } = fakes({ on: false });
    expect([await activities.startPipelines({ candidateId: CANDIDATE }), calls]).toEqual([
      { on: false },
      { queue: [], pipelines: [], submissions: [] },
    ]);
  });

  it("queues under the daily cap, starts each queued round's run for today and each open round's submission", async () => {
    const { activities, calls } = fakes({});
    expect([await activities.startPipelines({ candidateId: CANDIDATE }), calls]).toEqual([
      {
        on: true,
        queue: QUEUED,
        pipelines: { started: 1, existing: 0 },
        submissions: { started: 1, existing: 0 },
      },
      {
        queue: [7],
        pipelines: [
          [
            { candidateId: CANDIDATE, applicationId: app(1) },
            { round: 1, day: "2026-11-28" },
          ],
        ],
        submissions: [{ candidateId: CANDIDATE, applicationId: app(2), packageSha256: SHA }],
      },
    ]);
  });

  it("starts at most MAX_PIPELINE_STARTS_PER_PASS new runs a pass, counting ones already started apart", async () => {
    const queued = Array.from({ length: 15 }, (_, i) => ({ applicationId: app(i + 1), rounds: 0 }));
    const { activities } = fakes({
      work: { queued, openRounds: [] },
      existing: [app(1), app(2)],
    });
    const pass = await activities.startPipelines({ candidateId: CANDIDATE });
    expect(pass.on && pass.pipelines).toEqual({
      started: MAX_PIPELINE_STARTS_PER_PASS,
      existing: 2,
    });
  });

  it("tries every start when one fails, then fails the attempt with class names only", async () => {
    const { activities, calls } = fakes({
      work: {
        queued: [
          { applicationId: app(1), rounds: 0 },
          { applicationId: app(2), rounds: 0 },
        ],
        openRounds: [{ applicationId: app(3), packageSha256: SHA }],
      },
      failStart: app(1),
    });
    let failure: unknown;
    try {
      await activities.startPipelines({ candidateId: CANDIDATE });
    } catch (error) {
      failure = error;
    }
    const f = failure as ApplicationFailure;
    expect([
      f instanceof ApplicationFailure && [f.type, f.message, f.nonRetryable],
      calls.pipelines.length,
      calls.submissions.length,
    ]).toEqual([["StarterStepsFailed", "TypeError", false], 1, 1]);
  });
});

describe("the starter's dead letter (NS-280 slice 3)", () => {
  it("is a pipeline.start letter on the candidate, keyed by the run", () => {
    expect(starterLetter(CandidateId.parse(CANDIDATE), "pipeline_start:run-1")).toEqual({
      candidateId: CANDIDATE,
      kind: "pipeline.start",
      subject: `candidate:${CANDIDATE}`,
      reasonCode: "start_pass_failed",
      attempts: 3,
      idempotencyKey: "pipeline_start:run-1",
    });
  });
});
