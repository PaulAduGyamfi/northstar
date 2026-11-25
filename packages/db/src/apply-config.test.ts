import { describe, expect, it } from "vitest";
import {
  type ApplyLimits,
  checkApplyLimits,
  DEFAULT_APPLY_LIMITS,
  loadApplyLimits,
} from "./apply-config.js";

describe("loadApplyLimits", () => {
  it("defaults to 25 a day and 90 seconds apart when nothing is set (APPLY-007)", () => {
    expect(loadApplyLimits({})).toEqual({ dailyCap: 25, minGapMs: 90_000 });
    expect(DEFAULT_APPLY_LIMITS).toEqual({ dailyCap: 25, minGapMs: 90_000 });
  });

  it("accepts a lower cap and a longer gap", () => {
    expect(loadApplyLimits({ APPLY_DAILY_CAP: "10", APPLY_MIN_GAP_SECONDS: "300" })).toEqual({
      dailyCap: 10,
      minGapMs: 300_000,
    });
  });

  it.each(["26", "0", "-1", "2.5", "ten", ""])("refuses %j as the daily cap", (value) => {
    expect(() => loadApplyLimits({ APPLY_DAILY_CAP: value })).toThrow(
      "APPLY_DAILY_CAP must be a whole number from 1 to 25",
    );
  });

  it.each(["89", "0", "86401", "1e3", "ninety"])("refuses %j as the minimum gap", (value) => {
    expect(() => loadApplyLimits({ APPLY_MIN_GAP_SECONDS: value })).toThrow(
      "APPLY_MIN_GAP_SECONDS must be a whole number from 90 to 86400",
    );
  });
});

describe("checkApplyLimits", () => {
  it("refuses limits cast past APPLY-007 at run time, whatever the type says", () => {
    const raised = { dailyCap: 1000, minGapMs: 0 } as unknown as ApplyLimits;
    expect(() => checkApplyLimits(raised)).toThrow(
      "apply limits must be a cap from 1 to 25 and a gap from 90 s to a day",
    );
  });

  it("returns limits from the config module unchanged", () => {
    const limits = loadApplyLimits({ APPLY_DAILY_CAP: "3" });
    expect(checkApplyLimits(limits)).toEqual({ dailyCap: 3, minGapMs: 90_000 });
  });
});
