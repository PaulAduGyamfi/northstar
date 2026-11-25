import { describe, expect, it } from "vitest";
import {
  KIND_WORDS,
  QueueBody,
  secondsLeft,
  summarizeOutcomes,
  undoLabel,
  waitedFor,
} from "./approvals";

// The approval queue page's plain logic (NS-139), without a browser. Synthetic ids only.
const T = Date.parse("2026-11-25T12:00:00.000Z");

describe("QueueBody", () => {
  it("accepts the API's queue and refuses a kind the Gate doesn't know", () => {
    const item = {
      requestId: "r1",
      kind: "answer",
      subject: "answer:r1",
      requestedAt: "2026-11-25T12:00:00.000Z",
    };
    expect(QueueBody.safeParse({ items: [item] }).success).toBe(true);
    expect(QueueBody.safeParse({ items: [{ ...item, kind: "anything" }] }).success).toBe(false);
  });
});

describe("KIND_WORDS", () => {
  it("names every kind in plain words", () => {
    expect(KIND_WORDS.application_package).toBe("Application");
    expect(Object.values(KIND_WORDS).every((w) => w.length > 0)).toBe(true);
  });
});

describe("secondsLeft", () => {
  it("counts down to effectiveAt and reaches zero exactly at it", () => {
    const at = "2026-11-25T12:02:00.000Z";
    expect([
      secondsLeft(at, T),
      secondsLeft(at, T + 119_500),
      secondsLeft(at, T + 120_000),
      secondsLeft(at, T + 125_000),
    ]).toEqual([120, 1, 0, 0]);
  });

  it("is zero for a time it can't read", () => {
    expect(secondsLeft("not a time", T)).toBe(0);
  });
});

describe("undoLabel", () => {
  it("shows minutes and seconds left", () => {
    expect([undoLabel(120), undoLabel(65), undoLabel(9)]).toEqual([
      "Undo (2:00)",
      "Undo (1:05)",
      "Undo (0:09)",
    ]);
  });
});

describe("waitedFor", () => {
  it("says how long an item has waited, in words", () => {
    expect([
      waitedFor("2026-11-25T11:59:30.000Z", T),
      waitedFor("2026-11-25T11:45:00.000Z", T),
      waitedFor("2026-11-25T09:00:00.000Z", T),
      waitedFor("2026-11-23T12:00:00.000Z", T),
    ]).toEqual(["just now", "15 min", "3 h", "2 days"]);
  });
});

describe("summarizeOutcomes", () => {
  it("counts what was decided and what had already been decided elsewhere", () => {
    expect(
      summarizeOutcomes([
        { requestId: "a", outcome: "approved", decisionId: "d1", effectiveAt: "x" },
        { requestId: "b", outcome: "approved", decisionId: "d2", effectiveAt: "x" },
        { requestId: "c", outcome: "already_decided" },
        { requestId: "d", outcome: "not_found" },
      ]),
    ).toBe("Approved 2. 1 was already decided. 1 is no longer in the queue.");
    expect(
      summarizeOutcomes([
        { requestId: "a", outcome: "rejected", decisionId: "d1", effectiveAt: "x" },
      ]),
    ).toBe("Rejected 1.");
  });
});
