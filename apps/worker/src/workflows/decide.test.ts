import { describe, expect, it } from "vitest";
import { decide, MAX_WAITS } from "./decide.js";
import type { SubmitStep } from "./types.js";

const refused = (refusal: string, waitMs: number | null = null): SubmitStep => ({
  kind: "refused",
  refusal,
  waitMs,
});

describe("decide", () => {
  it("finishes with the gateway's outcome when the submission is done", () => {
    const step: SubmitStep = {
      kind: "done",
      outcome: "needs_human",
      submissionId: "s1",
      reason: "captcha",
      replayed: false,
    };
    expect(decide(step, 0)).toEqual({
      kind: "finish",
      result: { kind: "needs_human", submissionId: "s1", reason: "captcha", replayed: false },
    });
  });

  it.each([
    "InvalidPackage",
    "HostNotAllowed",
    "PostingMismatch",
    "FileChanged",
    "DuplicateRequisition",
  ])("stops for good on %s", (refusal) => {
    expect(decide(refused(refusal), 0)).toEqual({
      kind: "finish",
      result: { kind: "refused", refusal },
    });
  });

  it.each(["Paced", "DailyCapReached", "HeldBack"])(
    "waits exactly until the gateway's time on a dated %s",
    (refusal) => {
      expect(decide(refused(refusal, 42_000), 3)).toEqual({ kind: "wait", ms: 42_000 });
    },
  );

  it("keeps a dated wait between one second and one day", () => {
    expect(decide(refused("Paced", 0), 0)).toEqual({ kind: "wait", ms: 1_000 });
    expect(decide(refused("DailyCapReached", 3 * 86_400_000), 0)).toEqual({
      kind: "wait",
      ms: 86_400_000,
    });
  });

  it("doubles an undated wait each time and caps it at 15 minutes", () => {
    expect(decide(refused("HeldBack"), 0)).toEqual({ kind: "wait", ms: 60_000 });
    expect(decide(refused("HeldBack"), 1)).toEqual({ kind: "wait", ms: 120_000 });
    expect(decide(refused("AtsBusy"), 0)).toEqual({ kind: "wait", ms: 120_000 });
    expect(decide(refused("InProgress"), 0)).toEqual({ kind: "wait", ms: 300_000 });
    expect(decide(refused("InProgress"), 5)).toEqual({ kind: "wait", ms: 900_000 });
    expect(decide(refused("UndoWindowOpen"), 0)).toEqual({ kind: "wait", ms: 120_000 });
  });

  it("gives up instead of waiting forever after the last allowed wait", () => {
    expect(decide(refused("HeldBack"), MAX_WAITS - 1).kind).toBe("wait");
    expect(decide(refused("HeldBack"), MAX_WAITS)).toEqual({
      kind: "finish",
      result: { kind: "gave_up", refusal: "HeldBack" },
    });
  });
});
