import { describe, expect, it } from "vitest";
import type { PackageStep } from "./pipeline-plan.js";
import { PIPELINE_ATTEMPTS, type PipelineSteps, runPipeline } from "./pipeline-run.js";

// The job pipeline's step order and endings (NS-280 slice 2) on fakes: which endings record a
// dead letter, with how many attempts, and which fail the run.

const SHA = "d".repeat(64);

class Cancelled extends Error {}
class Exhausted extends Error {}
class Stopped extends Error {}

function fakeSteps(options: {
  prepared?: PackageStep;
  failing?: "tailor" | "form" | "prepare" | "start";
  error?: Error;
  started?: "started" | "exists";
}) {
  const ran: string[] = [];
  const letters: [string, number][] = [];
  const fail = (name: string) => {
    ran.push(name);
    if (options.failing === name) throw options.error ?? new Error("down");
  };
  const steps: PipelineSteps = {
    tailor: async () => {
      fail("tailor");
      return { kind: "tailored", saved: true };
    },
    form: async () => {
      fail("form");
      return { kind: "stored" };
    },
    prepare: async () => {
      fail("prepare");
      return options.prepared ?? { kind: "filed", packageSha256: SHA };
    },
    start: async (sha) => {
      fail(`start:${sha === SHA}`);
      if (options.failing === "start") throw options.error ?? new Error("down");
      return { kind: options.started ?? "started" };
    },
    letter: async (reasonCode, attempts) => {
      letters.push([reasonCode, attempts]);
    },
    failureOf: (error) =>
      error instanceof Cancelled
        ? "cancelled"
        : error instanceof Exhausted
          ? "exhausted"
          : "failed",
    stop: (reasonCode) => {
      throw new Stopped(reasonCode);
    },
  };
  return { steps, ran, letters };
}

async function outcome(run: Promise<unknown>): Promise<unknown> {
  try {
    return await run;
  } catch (error) {
    return [(error as Error).constructor.name, (error as Error).message];
  }
}

describe("runPipeline (NS-280 slice 2)", () => {
  it("runs the steps in order and starts the filed round's submission, recording no letter", async () => {
    const f = fakeSteps({});
    expect([await runPipeline(f.steps), f.ran, f.letters]).toEqual([
      { kind: "submission_started", packageSha256: SHA },
      ["tailor", "form", "prepare", "start:true"],
      [],
    ]);
  });

  it("reads a submission an earlier run started as already there", async () => {
    const f = fakeSteps({ started: "exists" });
    expect(await runPipeline(f.steps)).toEqual({ kind: "submission_exists", packageSha256: SHA });
  });

  it("ends at Paul's needs-you line or a skip without a letter or a submission", async () => {
    const needed = fakeSteps({ prepared: { kind: "needs_human" } });
    const skipped = fakeSteps({ prepared: { kind: "skipped", reason: "not_queued" } });
    expect([
      await runPipeline(needed.steps),
      await runPipeline(skipped.steps),
      needed.ran.includes("start:true") || skipped.ran.includes("start:true"),
      [...needed.letters, ...skipped.letters],
    ]).toEqual([{ kind: "needs_human" }, { kind: "skipped", reason: "not_queued" }, false, []]);
  });

  it("records a refusal's letter and then fails the run, starting nothing", async () => {
    const f = fakeSteps({
      prepared: { kind: "stopped", reasonCode: "file_refused_invalid_request" },
    });
    expect([await outcome(runPipeline(f.steps)), f.letters, f.ran.includes("start:true")]).toEqual([
      ["Stopped", "file_refused_invalid_request"],
      [["file_refused_invalid_request", 1]],
      false,
    ]);
  });

  it("records a step that ran out of retries with its attempts, rethrows, and runs no later step", async () => {
    const f = fakeSteps({ failing: "form", error: new Exhausted("held back") });
    expect([await outcome(runPipeline(f.steps)), f.letters, f.ran]).toEqual([
      ["Exhausted", "held back"],
      [["form_failed", PIPELINE_ATTEMPTS.form]],
      ["tailor", "form"],
    ]);
  });

  it("records one attempt for a step that failed for good at once", async () => {
    const f = fakeSteps({ failing: "start" });
    expect([await outcome(runPipeline(f.steps)), f.letters]).toEqual([
      ["Error", "down"],
      [["start_failed", 1]],
    ]);
  });

  it("records nothing when the workflow is cancelled mid-step", async () => {
    const f = fakeSteps({ failing: "tailor", error: new Cancelled("stop") });
    expect([await outcome(runPipeline(f.steps)), f.letters]).toEqual([["Cancelled", "stop"], []]);
  });
});
