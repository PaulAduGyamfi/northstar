import { describe, expect, it } from "vitest";
import { loadPoolLimits, workerOptions } from "./pools.js";
import { APPLY_BROWSER_QUEUE, PIPELINE_QUEUE } from "./queues.js";

// Bounded concurrency per worker pool (NS-219, RES-009). Plain code; no Temporal server.

describe("loadPoolLimits", () => {
  it("defaults to 4 pipeline tasks and 1 browser at a time", () => {
    expect(loadPoolLimits({})).toEqual({ [PIPELINE_QUEUE]: 4, [APPLY_BROWSER_QUEUE]: 1 });
  });

  it("reads whole numbers up to each pool's ceiling, and treats empty as unset", () => {
    expect([
      loadPoolLimits({
        WORKER_PIPELINE_CONCURRENCY: "16",
        WORKER_APPLY_BROWSER_CONCURRENCY: "4",
      }),
      loadPoolLimits({ WORKER_PIPELINE_CONCURRENCY: "", WORKER_APPLY_BROWSER_CONCURRENCY: "2" }),
    ]).toEqual([
      { [PIPELINE_QUEUE]: 16, [APPLY_BROWSER_QUEUE]: 4 },
      { [PIPELINE_QUEUE]: 4, [APPLY_BROWSER_QUEUE]: 2 },
    ]);
  });

  it("refuses zero, negatives, fractions, text and values over the ceiling, naming only the setting", () => {
    const refusals = ["0", "-1", "1.5", "two", "17", " 3", "0x4"].map((value) => {
      try {
        loadPoolLimits({ WORKER_PIPELINE_CONCURRENCY: value });
        return "accepted";
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(new Set(refusals)).toEqual(
      new Set(["WORKER_PIPELINE_CONCURRENCY: a whole number from 1 to 16"]),
    );
  });

  it("refuses a browser pool over 4", () => {
    expect(() => loadPoolLimits({ WORKER_APPLY_BROWSER_CONCURRENCY: "5" })).toThrow(
      "WORKER_APPLY_BROWSER_CONCURRENCY: a whole number from 1 to 4",
    );
  });
});

describe("workerOptions", () => {
  it("gives each pool its own queue and limit for activities and workflow tasks", () => {
    const limits = { [PIPELINE_QUEUE]: 6, [APPLY_BROWSER_QUEUE]: 2 };
    expect([
      workerOptions(PIPELINE_QUEUE, limits),
      workerOptions(APPLY_BROWSER_QUEUE, limits),
    ]).toEqual([
      {
        taskQueue: "pipeline",
        maxConcurrentActivityTaskExecutions: 6,
        maxConcurrentWorkflowTaskExecutions: 6,
      },
      {
        taskQueue: "apply-browser",
        maxConcurrentActivityTaskExecutions: 2,
        maxConcurrentWorkflowTaskExecutions: 2,
      },
    ]);
  });
});
