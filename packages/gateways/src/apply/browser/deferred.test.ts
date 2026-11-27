import { describe, expect, it } from "vitest";
import type { FormDriver, PageState } from "../driver.js";
import { deferredFormDriver } from "./deferred.js";
import { DriverError } from "./driver.js";

// The deferred driver (NS-225) starts the browser on the first open and, once closed, takes no
// further browser action (ADR-0028). A fake launcher stands in for Chromium.

const PAGE: PageState = { kind: "challenge", challenge: "captcha" };

function fakeLauncher(gate?: Promise<void>) {
  const log: string[] = [];
  let launches = 0;
  const driver: FormDriver = {
    open: async (url) => {
      log.push(`open ${url}`);
      return PAGE;
    },
    fillAndSubmit: async () => {
      log.push("submit");
      return PAGE;
    },
    close: async () => {
      log.push("close");
    },
  };
  const launch = async () => {
    launches++;
    log.push("launch");
    if (gate) await gate;
    return driver;
  };
  return { launch, log, launches: () => launches };
}

describe("deferredFormDriver", () => {
  it("launches the browser once, on the first open, then passes every step through", async () => {
    const f = fakeLauncher();
    const d = deferredFormDriver(f.launch);
    expect(f.launches()).toBe(0);
    await d.open("https://boards.greenhouse.io/example/jobs/1");
    await d.fillAndSubmit([], []);
    await d.close();
    expect([f.launches(), f.log]).toEqual([
      1,
      ["launch", "open https://boards.greenhouse.io/example/jobs/1", "submit", "close"],
    ]);
  });

  it("launches nothing when closed before any open, and refuses an open afterwards", async () => {
    const f = fakeLauncher();
    const d = deferredFormDriver(f.launch);
    await d.close();
    await expect(d.open("https://boards.greenhouse.io/example/jobs/1")).rejects.toBeInstanceOf(
      DriverError,
    );
    expect([f.launches(), f.log]).toEqual([0, []]);
  });

  it("closes a browser still starting when closed, and the open never reaches a page", async () => {
    let release = () => {};
    const f = fakeLauncher(new Promise<void>((r) => (release = r)));
    const d = deferredFormDriver(f.launch);
    const opening = d.open("https://boards.greenhouse.io/example/jobs/1").catch((e) => e);
    const closing = d.close();
    release();
    const [opened] = await Promise.all([opening, closing]);
    expect(opened).toBeInstanceOf(DriverError);
    expect(f.log).toEqual(["launch", "close"]);
  });

  it("refuses a step after close, without touching the browser", async () => {
    const f = fakeLauncher();
    const d = deferredFormDriver(f.launch);
    await d.open("https://boards.greenhouse.io/example/jobs/1");
    await d.close();
    await expect(d.fillAndSubmit([], [])).rejects.toBeInstanceOf(DriverError);
    expect(f.log).toEqual(["launch", "open https://boards.greenhouse.io/example/jobs/1", "close"]);
  });

  it("never launches a browser for a submit without an open page", async () => {
    const f = fakeLauncher();
    const d = deferredFormDriver(f.launch);
    await expect(d.fillAndSubmit([], [])).rejects.toBeInstanceOf(DriverError);
    expect(f.launches()).toBe(0);
  });

  it("closes cleanly after a launch that failed, with nothing to close", async () => {
    const d = deferredFormDriver(async () => {
      throw new Error("no chromium at /some/path");
    });
    await expect(d.open("https://boards.greenhouse.io/example/jobs/1")).rejects.toThrow(
      "the browser didn't start (Error)",
    );
    await expect(d.close()).resolves.toBeUndefined();
  });

  // A launch timeout is this machine's trouble: as a DriverError the gateway never counts it
  // against the ATS's breaker, which only a step's own Timeout does.
  it("reports a launch that timed out as a driver error naming only the error's class", async () => {
    const d = deferredFormDriver(async () => {
      const e = new Error("launch timed out after 30000ms");
      e.name = "TimeoutError";
      throw e;
    });
    const failure = await d.open("https://boards.greenhouse.io/example/jobs/1").catch((e) => e);
    expect([failure instanceof DriverError, (failure as Error).message]).toEqual([
      true,
      "the browser didn't start (TimeoutError)",
    ]);
  });
});
