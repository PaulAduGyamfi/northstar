import { describe, expect, it } from "vitest";
import { type Pool, runPools, stopPools } from "./run-pools.js";

// The pools stop together, and the first failure is the one reported (NS-225).

function fakePool(name: string, log: string[]) {
  let finish: (() => void) | null = null;
  let fail: ((e: Error) => void) | null = null;
  const pool: Pool = {
    run: () =>
      new Promise<void>((resolve, reject) => {
        log.push(`${name} run`);
        finish = resolve;
        fail = reject;
      }),
    shutdown: () => {
      log.push(`${name} shutdown`);
      finish?.();
    },
  };
  return { pool, fail: (e: Error) => fail?.(e) };
}

describe("runPools", () => {
  it("shuts every other pool down when one fails, and rethrows that pool's error", async () => {
    const log: string[] = [];
    const pipeline = fakePool("pipeline", log);
    const browser = fakePool("browser", log);
    const running = runPools([pipeline.pool, browser.pool]).catch((e: Error) => e.message);
    browser.fail(new Error("browser pool crashed"));
    expect(await running).toBe("browser pool crashed");
    expect(log).toEqual(["pipeline run", "browser run", "pipeline shutdown"]);
  });

  it("keeps the first failure when stopping the others throws too", async () => {
    const log: string[] = [];
    const a = fakePool("a", log);
    // b stops when asked, but its shutdown also throws, as Temporal's does for a worker already
    // stopping.
    let release: () => void = () => {};
    const b: Pool = {
      run: () => new Promise<void>((r) => (release = r)),
      shutdown: () => {
        release();
        throw new Error("already stopping");
      },
    };
    const running = runPools([a.pool, b]).catch((e: Error) => e.message);
    a.fail(new Error("first"));
    expect(await running).toBe("first");
  });

  it("returns when every pool stops cleanly", async () => {
    const log: string[] = [];
    const a = fakePool("a", log);
    const running = runPools([a.pool]);
    a.pool.shutdown();
    await expect(running).resolves.toBeUndefined();
  });
});

describe("stopPools", () => {
  it("starts and at once shuts down pools that were created but never run", async () => {
    const log: string[] = [];
    const a = fakePool("a", log);
    await stopPools([a.pool]);
    expect(log).toEqual(["a run", "a shutdown"]);
  });
});
