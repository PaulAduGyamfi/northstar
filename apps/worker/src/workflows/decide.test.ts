import { ApplicationFailure } from "@temporalio/common";
import { describe, expect, it } from "vitest";
import { decide, MAX_WAITS, notApprovedReason, stillWaiting } from "./decide.js";
import type { RefusalKind, SubmitStep } from "./types.js";

const refused = (refusal: RefusalKind, waitMs: number | null = null): SubmitStep => ({
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
    "PostingClosed",
  ] as const)("stops for good on %s", (refusal) => {
    expect(decide(refused(refusal), 0)).toEqual({
      kind: "finish",
      result: { kind: "refused", refusal },
    });
  });

  it.each(["Paced", "DailyCapReached", "HeldBack"] as const)(
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

describe("notApprovedReason", () => {
  it("reads the Gate's refusal kind from the activity's NotApproved failure", () => {
    expect(notApprovedReason(ApplicationFailure.nonRetryable("Rejected", "NotApproved"))).toBe(
      "Rejected",
    );
  });

  it("ignores every other failure, so the workflow fails visibly instead", () => {
    expect(notApprovedReason(ApplicationFailure.nonRetryable("x", "InvalidInput"))).toBeNull();
    expect(notApprovedReason(new Error("database down"))).toBeNull();
    expect(notApprovedReason(undefined)).toBeNull();
  });
});

describe("stillWaiting", () => {
  it("waits only while there is neither a decision nor a withdrawal", () => {
    const id = "00000000-0000-4000-8000-0000000000d1";
    expect([
      stillWaiting(null, false),
      stillWaiting(id, false),
      stillWaiting(null, true),
      stillWaiting(id, true),
    ]).toEqual([true, false, false, false]);
  });
});
