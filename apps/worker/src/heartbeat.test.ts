import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Beat, HEARTBEAT_MS, startHeartbeats } from "./heartbeat.js";

// The worker's heartbeats (NS-225 slice 3), on fake timers.

const STARTED = new Date("2026-11-27T18:00:00Z");
const BEATS: Beat[] = [
  { queue: "pipeline", enabled: true, startedAt: STARTED },
  { queue: "apply-browser", enabled: false, startedAt: STARTED },
];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const deps = (record: (b: Beat) => Promise<void>, errors: string[] = []) => ({
  record,
  every: (fn: () => void, ms: number) => setInterval(fn, ms),
  cancel: (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>),
  onError: (e: string) => errors.push(e),
});

describe("startHeartbeats", () => {
  it("beats for every pool at once, then every 30 s, until stopped", async () => {
    const seen: string[] = [];
    const hb = startHeartbeats(
      BEATS,
      deps(async (b) => {
        seen.push(b.queue);
      }),
    );
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    hb.stop();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(seen).toEqual([
      "pipeline",
      "apply-browser",
      "pipeline",
      "apply-browser",
      "pipeline",
      "apply-browser",
    ]);
  });

  it("logs a failed beat by its error class only, and keeps beating", async () => {
    const errors: string[] = [];
    let calls = 0;
    const hb = startHeartbeats(
      [BEATS[0] as Beat],
      deps(async () => {
        calls++;
        if (calls === 1) {
          const e = new Error("connection to postgres://user:secret@host failed");
          e.name = "DatabaseError";
          throw e;
        }
      }, errors),
    );
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    hb.stop();
    expect([calls, errors]).toEqual([2, ["DatabaseError"]]);
  });

  it("skips a beat while the last one is still in flight", async () => {
    let calls = 0;
    let release = () => {};
    const hb = startHeartbeats(
      [BEATS[0] as Beat],
      deps(() => {
        calls++;
        return new Promise<void>((r) => (release = r));
      }),
    );
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(calls).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    hb.stop();
    expect(calls).toBe(2);
  });
});
