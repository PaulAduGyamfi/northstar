import { err, ok } from "@northstar/domain";
import { NotApprovedError } from "@northstar/gateways";
import { ApplicationFailure } from "@temporalio/common";
import { describe, expect, it } from "vitest";
import { NOT_APPROVED } from "../workflows/types.js";
import { createApplyActivities } from "./apply.js";

const args = {
  candidateId: "00000000-0000-4000-8000-000000000001",
  decisionId: "decision-1",
  package: { any: "package" },
};
const now = () => new Date("2026-11-26T08:00:00Z");

describe("the submitApplication activity", () => {
  it("passes the decision id and package to the gateway and returns its outcome", async () => {
    const seen: unknown[] = [];
    const activities = createApplyActivities(async (input) => {
      seen.push(input);
      return ok({ outcome: "submitted", submissionId: "s1", proofId: "p1", replayed: true });
    }, now);
    await expect(activities.submitApplication(args)).resolves.toEqual({
      kind: "done",
      outcome: "submitted",
      submissionId: "s1",
      reason: null,
      replayed: true,
    });
    expect(seen).toEqual([args]);
  });

  it("returns the needs_human reason code", async () => {
    const activities = createApplyActivities(async () =>
      ok({ outcome: "needs_human", submissionId: "s2", reason: "captcha", replayed: false }),
    );
    await expect(activities.submitApplication(args)).resolves.toMatchObject({
      outcome: "needs_human",
      reason: "captcha",
    });
  });

  it("turns a refusal's retryAt into a wait from the activity's own clock", async () => {
    const activities = createApplyActivities(
      async () => err({ kind: "Paced", retryAt: new Date("2026-11-26T08:01:30Z") }),
      now,
    );
    await expect(activities.submitApplication(args)).resolves.toEqual({
      kind: "refused",
      refusal: "Paced",
      waitMs: 90_000,
    });
  });

  it("gives no wait for a refusal without a time", async () => {
    const activities = createApplyActivities(async () => err({ kind: "AtsBusy" }), now);
    await expect(activities.submitApplication(args)).resolves.toEqual({
      kind: "refused",
      refusal: "AtsBusy",
      waitMs: null,
    });
  });

  it("fails without retry when the Gate doesn't verify the decision", async () => {
    const activities = createApplyActivities(async () => {
      throw new NotApprovedError("Rejected");
    }, now);
    const failure = await activities.submitApplication(args).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure).toMatchObject({ type: NOT_APPROVED, nonRetryable: true, message: "Rejected" });
  });

  it("reports an approval still inside its undo window as a refusal to wait out", async () => {
    const activities = createApplyActivities(async () => {
      throw new NotApprovedError("UndoWindowOpen");
    }, now);
    await expect(activities.submitApplication(args)).resolves.toEqual({
      kind: "refused",
      refusal: "UndoWindowOpen",
      waitMs: null,
    });
  });

  it("waits until the undo window's end when a changed package's withdrawal was refused (NS-234)", async () => {
    const activities = createApplyActivities(async () => {
      throw new NotApprovedError("ContentChanged", new Date("2026-11-26T08:01:30Z"));
    }, now);
    await expect(activities.submitApplication(args)).resolves.toEqual({
      kind: "refused",
      refusal: "UndoWindowOpen",
      waitMs: 90_000,
    });
  });

  it("fails without retry for a changed package once its approval is withdrawn", async () => {
    const activities = createApplyActivities(async () => {
      throw new NotApprovedError("ContentChanged");
    }, now);
    const failure = await activities.submitApplication(args).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      type: NOT_APPROVED,
      nonRetryable: true,
      message: "ContentChanged",
    });
  });

  it("lets any other gateway error through for the retry policy", async () => {
    const boom = new Error("database down");
    const activities = createApplyActivities(async () => {
      throw boom;
    }, now);
    await expect(activities.submitApplication(args)).rejects.toBe(boom);
  });

  it("refuses a candidate id that isn't a uuid, without retry, before calling the gateway", async () => {
    let called = false;
    const activities = createApplyActivities(async () => {
      called = true;
      return err({ kind: "AtsBusy" });
    }, now);
    const failure = await activities
      .submitApplication({ ...args, candidateId: "nope" })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ type: "InvalidInput", nonRetryable: true });
    expect(called).toBe(false);
  });
});
