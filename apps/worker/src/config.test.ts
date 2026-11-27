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
});
