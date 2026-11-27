import { type ApplicationPackage, err, ok } from "@northstar/domain";
import { NotApprovedError } from "@northstar/gateways";
import { ApplicationFailure } from "@temporalio/common";
import { describe, expect, it } from "vitest";
import { NOT_APPROVED } from "../workflows/types.js";
import { createApplyActivities, type LoadPackage } from "./apply.js";

const args = {
  candidateId: "00000000-0000-4000-8000-000000000001",
  applicationId: "00000000-0000-4000-8000-0000000000a1",
  decisionId: "00000000-0000-4000-8000-0000000000d1",
  packageSha256: "b".repeat(64),
};
const now = () => new Date("2026-11-26T08:00:00Z");
// Stands in for the stored package: only its identity matters to these tests.
const PACKAGE = { applicationId: args.applicationId } as unknown as ApplicationPackage;
const loaded: LoadPackage = async () => ok(PACKAGE);

describe("the submitApplication activity", () => {
  it("passes the decision id and the stored package to the gateway and returns its outcome", async () => {
    const seen: unknown[] = [];
    const activities = createApplyActivities(
      async (input) => {
        seen.push(input);
        return ok({ outcome: "submitted", submissionId: "s1", proofId: "p1", replayed: true });
      },
      loaded,
      now,
    );
    await expect(activities.submitApplication(args)).resolves.toEqual({
      kind: "done",
      outcome: "submitted",
      submissionId: "s1",
      reason: null,
      replayed: true,
    });
    expect(seen).toEqual([
      { candidateId: args.candidateId, decisionId: args.decisionId, package: PACKAGE },
    ]);
  });

  it("returns the needs_human reason code", async () => {
    const activities = createApplyActivities(
      async () =>
        ok({ outcome: "needs_human", submissionId: "s2", reason: "captcha", replayed: false }),
      loaded,
    );
    await expect(activities.submitApplication(args)).resolves.toMatchObject({
      outcome: "needs_human",
      reason: "captcha",
    });
  });

  it("turns a refusal's retryAt into a wait from the activity's own clock", async () => {
    const activities = createApplyActivities(
      async () => err({ kind: "Paced", retryAt: new Date("2026-11-26T08:01:30Z") }),
      loaded,
      now,
    );
    await expect(activities.submitApplication(args)).resolves.toEqual({
      kind: "refused",
      refusal: "Paced",
      waitMs: 90_000,
    });
  });

  it("gives no wait for a refusal without a time", async () => {
    const activities = createApplyActivities(async () => err({ kind: "AtsBusy" }), loaded, now);
    await expect(activities.submitApplication(args)).resolves.toEqual({
      kind: "refused",
      refusal: "AtsBusy",
      waitMs: null,
    });
  });

  it("fails without retry when the Gate doesn't verify the decision", async () => {
    const activities = createApplyActivities(
      async () => {
        throw new NotApprovedError("Rejected");
      },
      loaded,
      now,
    );
    const failure = await activities.submitApplication(args).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure).toMatchObject({ type: NOT_APPROVED, nonRetryable: true, message: "Rejected" });
  });

  it("reports an approval still inside its undo window as a refusal to wait out", async () => {
    const activities = createApplyActivities(
      async () => {
        throw new NotApprovedError("UndoWindowOpen");
      },
      loaded,
      now,
    );
    await expect(activities.submitApplication(args)).resolves.toEqual({
      kind: "refused",
      refusal: "UndoWindowOpen",
      waitMs: null,
    });
  });

  it("waits until the undo window's end when a changed package's withdrawal was refused (NS-234)", async () => {
    const activities = createApplyActivities(
      async () => {
        throw new NotApprovedError("ContentChanged", new Date("2026-11-26T08:01:30Z"));
      },
      loaded,
      now,
    );
    await expect(activities.submitApplication(args)).resolves.toEqual({
      kind: "refused",
      refusal: "UndoWindowOpen",
      // 90 s to the window's end, plus a second for clock skew.
      waitMs: 91_000,
    });
  });

  it("fails without retry for a changed package once its approval is withdrawn", async () => {
    const activities = createApplyActivities(
      async () => {
        throw new NotApprovedError("ContentChanged");
      },
      loaded,
      now,
    );
    const failure = await activities.submitApplication(args).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      type: NOT_APPROVED,
      nonRetryable: true,
      message: "ContentChanged",
    });
  });

  it("lets any other gateway error through for the retry policy", async () => {
    const boom = new Error("database down");
    const activities = createApplyActivities(
      async () => {
        throw boom;
      },
      loaded,
      now,
    );
    await expect(activities.submitApplication(args)).rejects.toBe(boom);
  });

  it("refuses a candidate id that isn't a uuid, without retry, before calling the gateway", async () => {
    let called = false;
    const activities = createApplyActivities(
      async () => {
        called = true;
        return err({ kind: "AtsBusy" });
      },
      loaded,
      now,
    );
    const failure = await activities
      .submitApplication({ ...args, candidateId: "nope" })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ type: "InvalidInput", nonRetryable: true });
    expect(called).toBe(false);
  });

  it("loads the package by the decision, application and hash it was given", async () => {
    const asked: unknown[] = [];
    const activities = createApplyActivities(
      async () => ok({ outcome: "submitted", submissionId: "s1", proofId: "p1", replayed: false }),
      async (candidateId, named) => {
        asked.push({ candidateId, ...named });
        return ok(PACKAGE);
      },
      now,
    );
    await activities.submitApplication(args);
    expect(asked).toEqual([
      {
        candidateId: args.candidateId,
        decisionId: args.decisionId,
        applicationId: args.applicationId,
        contentSha256: args.packageSha256,
      },
    ]);
  });

  it.each([
    ["Mismatch", "PackageMismatch"],
    ["NoPackage", "NoPackage"],
  ] as const)(
    "refuses a package that isn't the one named (%s), without retry and without calling the gateway",
    async (kind, reason) => {
      let called = false;
      const activities = createApplyActivities(
        async () => {
          called = true;
          return err({ kind: "AtsBusy" });
        },
        async () => err({ kind }),
        now,
      );
      const failure = await activities.submitApplication(args).catch((error: unknown) => error);
      expect(failure).toMatchObject({ type: NOT_APPROVED, nonRetryable: true, message: reason });
      expect(called).toBe(false);
    },
  );

  it("lets a failed package read through for the retry policy", async () => {
    const boom = new Error("database down");
    const activities = createApplyActivities(
      async () => err({ kind: "AtsBusy" }),
      async () => {
        throw boom;
      },
      now,
    );
    await expect(activities.submitApplication(args)).rejects.toBe(boom);
  });

  // NS-242: Temporal keeps activity arguments in plain text, so a package field must never come
  // back into them.
  it("refuses arguments that carry a package field, without retry, before loading anything", async () => {
    let loads = 0;
    const activities = createApplyActivities(
      async () => err({ kind: "AtsBusy" }),
      async () => {
        loads++;
        return ok(PACKAGE);
      },
      now,
    );
    const failure = await activities
      .submitApplication({ ...args, package: { applicationId: args.applicationId } } as never)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      type: "InvalidInput",
      nonRetryable: true,
      message: "unexpected input field: package",
    });
    expect(loads).toBe(0);
  });

  it.each([
    ["applicationId", "nope", "applicationId is not a uuid"],
    ["packageSha256", "B".repeat(64), "packageSha256 is not a sha-256"],
    ["decisionId", 7, "decisionId is not a string"],
  ])("refuses a malformed %s without retry", async (key, value, message) => {
    const activities = createApplyActivities(async () => err({ kind: "AtsBusy" }), loaded, now);
    const failure = await activities
      .submitApplication({ ...args, [key]: value } as never)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ type: "InvalidInput", nonRetryable: true, message });
  });
});
