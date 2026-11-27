import { describe, expect, it } from "vitest";
import { failureKey, planSweep, relayFailureKey } from "./sweep-plan.js";

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b1";

describe("planSweep", () => {
  it("sweeps each candidate once, every 5 minutes by default", () => {
    expect(planSweep({ candidateIds: [A, B, A] })).toEqual({
      ok: true,
      candidateIds: [A, B],
      minutes: 5,
    });
  });

  it("refuses a candidate id that isn't a uuid before any pass", () => {
    expect(planSweep({ candidateIds: [A, "nope"] })).toEqual({
      ok: false,
      problem: "candidate 1 is not a uuid",
    });
  });

  it("refuses an empty candidate list", () => {
    expect(planSweep({ candidateIds: [] })).toEqual({ ok: false, problem: "no candidates" });
  });

  it.each([0, -5, 1.5, Number.NaN, 1441])(
    "refuses an interval of %s minutes",
    (intervalMinutes) => {
      expect(planSweep({ candidateIds: [A], intervalMinutes })).toEqual({
        ok: false,
        problem: "intervalMinutes must be a whole number from 1 to 1440",
      });
    },
  );
});

describe("planSweep for the relay", () => {
  it("uses the default it is given when the input names no interval", () => {
    expect(planSweep({ candidateIds: [A] }, 1)).toEqual({
      ok: true,
      candidateIds: [A],
      minutes: 1,
    });
  });
});

describe("relayFailureKey", () => {
  it("names a failed relay pass by its workflow run and pass number", () => {
    expect(relayFailureKey("0f1e2d3c-4b5a-4968-8776-655443322110", 7)).toBe(
      "signal_relay:0f1e2d3c-4b5a-4968-8776-655443322110:7",
    );
  });
});

describe("failureKey", () => {
  it("names a failed pass by its workflow run and pass number", () => {
    expect(failureKey("0f1e2d3c-4b5a-4968-8776-655443322110", 7)).toBe(
      "stale_sweep:0f1e2d3c-4b5a-4968-8776-655443322110:7",
    );
  });
});
