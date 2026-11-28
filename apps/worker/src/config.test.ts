import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "./config.js";

// The worker process's settings (NS-225). Errors name the setting, never its value.

describe("loadWorkerConfig", () => {
  it("defaults to the local Temporal, the default namespace and the browser pool off", () => {
    const c = loadWorkerConfig({});
    expect([c.temporalAddress, c.temporalNamespace, c.applyBrowser]).toEqual([
      "127.0.0.1:7233",
      "default",
      { on: false },
    ]);
  });

  it.each(["127.0.0.1:7233", "127.0.0.1:17233", "[::1]:7233"])(
    "accepts a loopback address (%s)",
    (TEMPORAL_ADDRESS) => {
      expect(loadWorkerConfig({ TEMPORAL_ADDRESS }).temporalAddress).toBe(TEMPORAL_ADDRESS);
    },
  );

  it.each([
    "temporal.example.com:7233",
    "localhost:7233",
    "10.0.0.5:7233",
    "127.0.0.1",
    "127.0.0.1:0",
    "127.0.0.1:70000",
  ])(
    "refuses an address off this machine or without a valid port (%s), naming only the setting",
    (TEMPORAL_ADDRESS) => {
      const thrown = (() => {
        try {
          loadWorkerConfig({ TEMPORAL_ADDRESS });
          return null;
        } catch (e) {
          return (e as Error).message;
        }
      })();
      expect(thrown).toBe("TEMPORAL_ADDRESS: host:port on this machine (127.0.0.1 or [::1])");
    },
  );

  it("refuses a namespace with other characters", () => {
    expect(() => loadWorkerConfig({ TEMPORAL_NAMESPACE: "ns with spaces" })).toThrow(
      "TEMPORAL_NAMESPACE: 1 to 64 letters, digits, '.', '_' or '-'",
    );
  });

  it("turns the browser pool on only with the installed Chromium's absolute path", () => {
    expect(
      loadWorkerConfig({
        WORKER_APPLY_BROWSER: "on",
        WORKER_CHROMIUM_PATH: "/opt/chromium/chrome",
      }).applyBrowser,
    ).toEqual({ on: true, chromiumPath: "/opt/chromium/chrome" });
  });

  it.each([{}, { WORKER_CHROMIUM_PATH: "chrome" }])(
    "refuses the browser pool on without an absolute Chromium path (%o)",
    (extra) => {
      expect(() => loadWorkerConfig({ WORKER_APPLY_BROWSER: "on", ...extra })).toThrow(
        "WORKER_CHROMIUM_PATH: the installed Chromium's absolute path, when the browser pool is on",
      );
    },
  );

  it("refuses any other value for the browser pool, without echoing it", () => {
    expect(() => loadWorkerConfig({ WORKER_APPLY_BROWSER: "yes-please" })).toThrow(
      /^WORKER_APPLY_BROWSER: on or off$/,
    );
  });

  it("keeps the pool limits and apply pacing from their own loaders", () => {
    const c = loadWorkerConfig({ WORKER_PIPELINE_CONCURRENCY: "2", APPLY_DAILY_CAP: "10" });
    expect([c.pools.pipeline, c.applyLimits.dailyCap]).toEqual([2, 10]);
  });

  it("keeps the job pipeline off by default, and on takes a daily cap of 5 unless set (NS-280)", () => {
    expect([
      loadWorkerConfig({}).jobPipeline,
      loadWorkerConfig({ WORKER_JOB_PIPELINE: "on" }).jobPipeline,
      loadWorkerConfig({ WORKER_JOB_PIPELINE: "on", WORKER_QUEUE_DAILY_CAP: "25" }).jobPipeline,
      loadWorkerConfig({ WORKER_JOB_PIPELINE: "off", WORKER_QUEUE_DAILY_CAP: "99" }).jobPipeline,
    ]).toEqual([
      { on: false },
      { on: true, dailyCap: 5 },
      { on: true, dailyCap: 25 },
      { on: false },
    ]);
  });

  it.each(["0", "26", "2.5", "-1", "five"])(
    "refuses a daily cap outside 1 to 25 (%s), without echoing it",
    (WORKER_QUEUE_DAILY_CAP) => {
      expect(() => loadWorkerConfig({ WORKER_JOB_PIPELINE: "on", WORKER_QUEUE_DAILY_CAP })).toThrow(
        /^WORKER_QUEUE_DAILY_CAP: a whole number from 1 to 25$/,
      );
    },
  );

  it("refuses any other value for the job pipeline", () => {
    expect(() => loadWorkerConfig({ WORKER_JOB_PIPELINE: "yes" })).toThrow(
      /^WORKER_JOB_PIPELINE: on or off$/,
    );
  });
});
