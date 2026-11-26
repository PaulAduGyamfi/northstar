import { describe, expect, it } from "vitest";
import {
  batchUndoLabel,
  KIND_WORDS,
  QueueBody,
  replyLines,
  secondsLeft,
  summarizeOutcomes,
  undoErrorWords,
  undoLabel,
  waitedFor,
} from "./approvals";

describe("batchUndoLabel", () => {
  it("says what the button undoes and how long is left", () => {
    expect([batchUndoLabel("approved", 3, 112), batchUndoLabel("rejected", 1, 9)]).toEqual([
      "Undo approving 3 (1:52)",
      "Undo rejecting 1 (0:09)",
    ]);
  });
});

describe("undoErrorWords", () => {
  it("tells signed out, closed, already undone, reopened and server errors apart", () => {
    expect([
      undoErrorWords(401, "unauthenticated"),
      undoErrorWords(409, "undo_window_closed"),
      undoErrorWords(409, "already_undone"),
      undoErrorWords(409, "subject_reopened"),
      undoErrorWords(500, "internal"),
      undoErrorWords(404, "not_found"),
    ]).toEqual([
      "You've been signed out. Sign in again to undo.",
      "Too late to undo: the window has closed.",
      "That was already undone.",
      "It can't be undone: it's been asked for again.",
      "That didn't go through. Try undo again.",
      "That decision can't be undone any more.",
    ]);
  });
});

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

describe("reply drafts (NS-237)", () => {
  const REPLY = {
    to: "jo@acme.example",
    replyToOtherDomain: false,
    subject: "Re: Your application",
    body: "Hi Jo, thank you.",
    cites: ["atom-1", "story-2"],
    followUps: ["Which week suits you?"],
  };

  it("shows who it goes to first, then the subject, body, questions and how much it cites", () => {
    expect(replyLines(REPLY)).toEqual([
      "To: jo@acme.example",
      "Subject: Re: Your application",
      "Hi Jo, thank you.",
      "Question for you: Which week suits you?",
      "It cites 2 of your stories or atoms.",
    ]);
  });

  it("warns right under the address when the reply goes to another domain than the sender's", () => {
    expect(replyLines({ ...REPLY, replyToOtherDomain: true, cites: [], followUps: [] })).toEqual([
      "To: jo@acme.example",
      "Check the address: the sender asked for replies on another domain than theirs.",
      "Subject: Re: Your application",
      "Hi Jo, thank you.",
      "It cites none of your stories or atoms.",
    ]);
  });

  it("says when an approve was refused because a reply had no draft", () => {
    expect(
      summarizeOutcomes([
        { requestId: "a", outcome: "missing_draft" },
        { requestId: "b", outcome: "missing_draft" },
      ]),
    ).toBe("2 replies have no draft to show, so they weren't approved.");
  });
});
