import type { Db } from "@northstar/db";
import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "./config.js";
import { workerActivities } from "./wiring.js";

// Each pool gets only its own activities (NS-225, RES-001). Binding touches neither the database
// nor a browser, so a stand-in database is enough here.
const db = {} as Db;
const launch = async () => {
  throw new Error("no browser in tests");
};

describe("workerActivities", () => {
  it("gives the pipeline pool the ending and sweep activities, and no browser pool while it is off", () => {
    const pools = workerActivities(db, loadWorkerConfig({}), launch);
    expect([Object.keys(pools.pipeline).sort(), pools.applyBrowser]).toEqual([
      ["recordSubmissionEnding", "recordSweepFailure", "sweepStaleClaims"],
      null,
    ]);
  });

  it("gives the browser pool only the submit activity once Paul turns it on", () => {
    const pools = workerActivities(
      db,
      loadWorkerConfig({
        WORKER_APPLY_BROWSER: "on",
        WORKER_CHROMIUM_PATH: "/opt/chromium/chrome",
      }),
      launch,
    );
    expect(Object.keys(pools.applyBrowser ?? {})).toEqual(["submitApplication"]);
  });
});
