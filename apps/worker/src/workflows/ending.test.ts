import { describe, expect, it } from "vitest";
import { endingKey, endingReason, snakeCase } from "./ending.js";

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
    // A reason is never copied as text: anything outside [a-z0-9_] goes.
    expect(endingReason({ kind: "not_approved", reason: "see https://x.example/?a=1" })).toBe(
      "not_approved_seehttpsxexamplea1",
    );
    expect(endingReason({ kind: "not_approved", reason: "!!" })).toBe("not_approved_unknown");
  });

  it("names a run whose activity failed every attempt", () => {
    expect(endingReason({ kind: "activity_failed" })).toBe("activity_failed");
  });

  it("always gives a valid dead-letter reason code, however long the name", () => {
    const long = endingReason({ kind: "not_approved", reason: "A".repeat(200) });
    expect(long).toMatch(REASON_CODE);
    expect(endingReason({ kind: "not_approved", reason: "Ab_".repeat(40) })).toMatch(REASON_CODE);
  });
});

describe("snakeCase", () => {
  it("splits words at capitals and collapses separators", () => {
    expect(snakeCase("InProgress")).toBe("in_progress");
    expect(snakeCase("__Odd__Name__")).toBe("odd_name");
  });
});

describe("endingKey", () => {
  it("keys the letter by application, one per application ever", () => {
    expect(endingKey("00000000-0000-4000-8000-0000000000a1")).toBe(
      "application:00000000-0000-4000-8000-0000000000a1:submit",
    );
  });
});
