import { describe, expect, it } from "vitest";
import {
  BASE_COOLDOWN_MS,
  type BreakerState,
  CLOSED,
  FAILURE_THRESHOLD,
  MAX_COOLDOWN_MS,
  onAcquire,
  onOutcome,
  PROBE_TIMEOUT_MS,
} from "./breaker.js";

const T0 = new Date("2026-11-25T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

// Fails the breaker `n` times at T0.
function failed(n: number, from: BreakerState = CLOSED): BreakerState {
  let s = from;
  for (let i = 0; i < n; i++) s = onOutcome(s, { ok: false, error: "TimeoutError" }, T0);
  return s;
}

describe("breaker", () => {
  it("stays closed below the failure threshold", () => {
    const s = failed(FAILURE_THRESHOLD - 1);
    expect(s.status).toBe("closed");
    expect(onAcquire(s, T0).decision).toEqual({ allowed: true, probe: false });
  });

  it("opens after five failures in a row and refuses calls until retryAt", () => {
    const s = failed(FAILURE_THRESHOLD);
    expect(s).toEqual({
      status: "open",
      consecutiveFailures: 5,
      opens: 1,
      retryAt: at(BASE_COOLDOWN_MS),
      lastError: "TimeoutError",
    });
    expect(onAcquire(s, at(BASE_COOLDOWN_MS - 1)).decision).toEqual({
      allowed: false,
      retryAt: at(BASE_COOLDOWN_MS),
      lastError: "TimeoutError",
    });
  });

  it("a success while closed resets the failure count", () => {
    const s = onOutcome(failed(4), { ok: true }, T0);
    expect(failed(4, s).status).toBe("closed");
  });

  it("allows one probe after retryAt and refuses others while it runs", () => {
    const open = failed(FAILURE_THRESHOLD);
    const first = onAcquire(open, at(BASE_COOLDOWN_MS));
    expect(first.decision).toEqual({ allowed: true, probe: true });
    expect(first.state.status).toBe("half_open");
    expect(first.state.retryAt).toEqual(at(BASE_COOLDOWN_MS + PROBE_TIMEOUT_MS));
    expect(onAcquire(first.state, at(BASE_COOLDOWN_MS + 1)).decision.allowed).toBe(false);
  });

  it("a probe success closes and resets the breaker", () => {
    const probing = onAcquire(failed(FAILURE_THRESHOLD), at(BASE_COOLDOWN_MS)).state;
    expect(onOutcome(probing, { ok: true }, at(BASE_COOLDOWN_MS + 5))).toEqual(CLOSED);
  });

  it("a probe failure reopens with a doubled pause, capped at fifteen minutes", () => {
    let s = failed(FAILURE_THRESHOLD);
    let now = T0;
    const pauses: number[] = [];
    for (let i = 0; i < 6; i++) {
      now = s.retryAt ?? now;
      s = onAcquire(s, now).state;
      s = onOutcome(s, { ok: false, error: "RateLimited" }, now);
      pauses.push((s.retryAt?.getTime() ?? 0) - now.getTime());
    }
    expect(pauses).toEqual([
      120_000,
      240_000,
      480_000,
      MAX_COOLDOWN_MS,
      MAX_COOLDOWN_MS,
      MAX_COOLDOWN_MS,
    ]);
    expect(s.status).toBe("open");
    expect(s.lastError).toBe("RateLimited");
  });

  it("replaces a probe that never reports once the probe timeout passes", () => {
    const probing = onAcquire(failed(FAILURE_THRESHOLD), at(BASE_COOLDOWN_MS)).state;
    const later = onAcquire(probing, at(BASE_COOLDOWN_MS + PROBE_TIMEOUT_MS));
    expect(later.decision).toEqual({ allowed: true, probe: true });
  });

  it("ignores a late failure report while open, so the pause isn't extended", () => {
    const open = failed(FAILURE_THRESHOLD);
    expect(onOutcome(open, { ok: false, error: "TimeoutError" }, at(10))).toEqual(open);
  });
});
