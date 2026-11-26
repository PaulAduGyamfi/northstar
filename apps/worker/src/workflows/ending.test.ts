import { describe, expect, it } from "vitest";
import {
  endingKey,
  endingLetter,
  endingReason,
  failedAttempts,
  inputProblem,
  snakeCase,
} from "./ending.js";

const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;

describe("endingReason", () => {
  it.each([
    { kind: "submitted", submissionId: "s1", reason: null, replayed: false },
    { kind: "needs_human", submissionId: "s1", reason: "captcha", replayed: false },
    { kind: "withdrawn" },
  ] as const)("records nothing for an ending already visible elsewhere ($kind)", (ending) => {
    expect(endingReason(ending)).toBeNull();
  });

  it("names a final refusal by its kind", () => {
    expect(endingReason({ kind: "refused", refusal: "DuplicateRequisition" })).toBe(
      "refused_duplicate_requisition",
    );
    expect(endingReason({ kind: "refused", refusal: "PostingClosed" })).toBe(
      "refused_posting_closed",
    );
  });

  it("names a give-up by the refusal it kept getting", () => {
    expect(endingReason({ kind: "gave_up", refusal: "HeldBack" })).toBe("gave_up_held_back");
    expect(endingReason({ kind: "gave_up", refusal: "UndoWindowOpen" })).toBe(
      "gave_up_undo_window_open",
    );
  });

  it("names a Gate refusal by its reason, keeping only safe characters", () => {
    expect(endingReason({ kind: "not_approved", reason: "Rejected" })).toBe(
      "not_approved_rejected",
    );
    expect(endingReason({ kind: "not_approved", reason: "ContentChanged" })).toBe(
      "not_approved_content_changed",
    );
    // Only the Gate's own kinds: any other text, even an address, never reaches the letter.
    expect(endingReason({ kind: "not_approved", reason: "paul@example.com" })).toBe(
      "not_approved_unknown",
    );
    expect(endingReason({ kind: "not_approved", reason: "!!" })).toBe("not_approved_unknown");
  });

  it("names a run whose activity failed every attempt", () => {
    expect(endingReason({ kind: "activity_failed" })).toBe("activity_failed");
  });

  it("always gives a valid dead-letter reason code, however long the name", () => {
    const long = endingReason({ kind: "refused", refusal: "A".repeat(200) as "PostingClosed" });
    expect(long).toMatch(REASON_CODE);
    expect(endingReason({ kind: "gave_up", refusal: "Ab_".repeat(40) as "HeldBack" })).toMatch(
      REASON_CODE,
    );
  });
});

describe("snakeCase", () => {
  it("splits words at capitals and collapses separators", () => {
    expect(snakeCase("InProgress")).toBe("in_progress");
    expect(snakeCase("__Odd__Name__")).toBe("odd_name");
  });
});

const APP = "00000000-0000-4000-8000-0000000000a1";
const RUN = "00000000-0000-4000-8000-0000000000f1";

describe("endingKey", () => {
  it("keys the letter by application and workflow run", () => {
    expect(endingKey(APP, RUN)).toBe(`application:${APP}:submit:${RUN}`);
    expect(endingKey(APP, RUN)).toMatch(/^[a-z0-9][a-z0-9_.:-]{0,199}$/);
  });
});

describe("inputProblem", () => {
  it("accepts an application id that is the package's own", () => {
    expect(inputProblem({ applicationId: APP, package: { applicationId: APP } })).toBeNull();
  });

  it("refuses an application id that isn't a uuid", () => {
    expect(inputProblem({ applicationId: "nope", package: { applicationId: "nope" } })).toBe(
      "applicationId is not a uuid",
    );
  });

  it.each([{ applicationId: RUN }, {}, null, "text"])(
    "refuses an id that isn't the package's own (%o)",
    (pkg) => {
      expect(inputProblem({ applicationId: APP, package: pkg })).toBe(
        "applicationId is not the package's",
      );
    },
  );
});

describe("endingLetter", () => {
  it("records a final refusal with the gateway calls made", () => {
    expect(endingLetter({ kind: "gave_up", refusal: "HeldBack" }, 21)).toEqual({
      reasonCode: "gave_up_held_back",
      attempts: 21,
    });
  });

  it("counts at least one attempt", () => {
    expect(endingLetter({ kind: "not_approved", reason: "Rejected" }, 0)).toEqual({
      reasonCode: "not_approved_rejected",
      attempts: 1,
    });
  });

  it("records nothing for an ending already visible", () => {
    expect(endingLetter({ kind: "withdrawn" }, 0)).toBeNull();
  });
});

describe("failedAttempts", () => {
  it("counts every attempt when Temporal stopped on the retry limit, plus earlier calls", () => {
    expect(failedAttempts(0, "MAXIMUM_ATTEMPTS_REACHED")).toBe(5);
    expect(failedAttempts(3, "MAXIMUM_ATTEMPTS_REACHED")).toBe(8);
  });

  it("counts one attempt for an error that was never retried", () => {
    expect(failedAttempts(0, "NON_RETRYABLE_FAILURE")).toBe(1);
    expect(failedAttempts(2, undefined)).toBe(3);
  });
});
