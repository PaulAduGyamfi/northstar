import { describe, expect, it } from "vitest";
import {
  batchUndoLabel,
  changedAnswers,
  editableAnswers,
  editProblem,
  editResultWords,
  KIND_WORDS,
  MAX_ANSWER,
  MAX_REPLY_BODY,
  PackageBody,
  packageEditBody,
  packageEditProblem,
  packageEditResultWords,
  packageLines,
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
      edited: false,
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

  it("says the reply is Paul's edit in place of the cites line (NS-203 slice 3)", () => {
    expect(replyLines(REPLY, true)).toEqual([
      "To: jo@acme.example",
      "Subject: Re: Your application",
      "Hi Jo, thank you.",
      "Question for you: Which week suits you?",
      "Edited by you: you changed this reply's text after it was drafted.",
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

  it("says when a reply to another domain must be approved on its own", () => {
    expect(summarizeOutcomes([{ requestId: "a", outcome: "approve_alone" }])).toBe(
      "1 reply goes to another domain than the sender's: show it and approve it on its own.",
    );
  });
});

describe("editProblem", () => {
  it("allows a changed, non-empty body within the limit", () => {
    expect(editProblem("Thanks.", "Thanks, Jo.")).toBe(null);
  });

  it("refuses an empty, too long or unchanged body before anything is sent", () => {
    expect([
      editProblem("Thanks.", "   \n"),
      editProblem("Thanks.", "x".repeat(MAX_REPLY_BODY + 1)),
      editProblem("Thanks.", "Thanks."),
    ]).toEqual([
      "The reply can't be empty.",
      "The reply is too long: at most 5,000 characters.",
      "Nothing changed, so there's nothing to save.",
    ]);
  });
});

describe("editResultWords", () => {
  it("says a saved edit is waiting for approval", () => {
    expect(editResultWords(200, undefined)).toBe(
      "Saved. Your edited version is waiting for your approval.",
    );
  });

  it("reads a second click's not_pending as already done, and other refusals plainly", () => {
    expect([
      editResultWords(409, "not_pending"),
      editResultWords(401, "unauthorized"),
      editResultWords(409, "unchanged"),
      editResultWords(404, "not_found"),
      editResultWords(409, "not_editable"),
      editResultWords(400, "invalid_body"),
      editResultWords(503, "unavailable"),
      editResultWords(418, "teapot"),
    ]).toEqual([
      "That reply isn't waiting any more, so nothing changed.",
      "You've been signed out. Sign in again to edit.",
      "Nothing changed, so there's nothing to save.",
      "That reply is gone. Reload the page.",
      "Only email replies can be edited.",
      "Northstar couldn't accept that text. Check it and try again.",
      "That didn't save. Try again.",
      "That edit couldn't be saved.",
    ]);
  });
});

describe("application package answers (NS-203 slice 5)", () => {
  const ANSWERS = [
    { fieldName: "question_1", label: "Why us?", value: "I like what you build.", editable: true },
    { fieldName: "question_2", label: "Relocate?", value: "Yes", editable: false },
  ];

  it("parses the API's answers", () => {
    expect(PackageBody.safeParse({ answers: ANSWERS }).success).toBe(true);
  });

  it("shows one line per answer and says a choice can't be edited here", () => {
    expect(packageLines(ANSWERS)).toEqual([
      "Why us?: I like what you build.",
      "Relocate?: Yes (a choice: not editable here)",
    ]);
  });

  it("says when Paul edited the answers, and when a package fills none", () => {
    expect([packageLines(ANSWERS, true).at(-1), packageLines([])]).toEqual([
      "Edited by you: you changed these answers after they were filled.",
      ["This application fills no questions."],
    ]);
  });

  it("lists only the text answers for editing", () => {
    expect(editableAnswers(ANSWERS).map((a) => a.fieldName)).toEqual(["question_1"]);
  });

  it("keeps only editable answers whose text changed", () => {
    const drafts = new Map([
      ["question_1", "I like what your team builds."],
      ["question_2", "No"],
    ]);
    expect([...changedAnswers(ANSWERS, drafts)]).toEqual([
      ["question_1", "I like what your team builds."],
    ]);
  });

  it("sends an answer to a field named __proto__ like any other", () => {
    const answers = [{ fieldName: "__proto__", label: "Why?", value: "Old.", editable: true }];
    const changed = changedAnswers(answers, new Map([["__proto__", "New."]]));
    expect(JSON.parse(packageEditBody("r1", changed))).toEqual(
      JSON.parse('{"requestId":"r1","fields":{"__proto__":"New."}}'),
    );
  });

  it("sends nothing unchanged, empty or too long", () => {
    expect([
      packageEditProblem(new Map()),
      packageEditProblem(new Map([["question_1", "  "]])),
      packageEditProblem(new Map([["question_1", "x".repeat(MAX_ANSWER + 1)]])),
      packageEditProblem(new Map([["question_1", "Fine."]])),
    ]).toEqual([
      "Nothing changed, so there's nothing to save.",
      "An answer can't be empty.",
      "An answer is too long: at most 10,000 characters.",
      null,
    ]);
  });

  it("words a package edit's answer, a second click's not_pending as already done", () => {
    expect([
      packageEditResultWords(200, undefined),
      packageEditResultWords(409, "not_pending"),
      packageEditResultWords(400, "invalid_input"),
      packageEditResultWords(413, "too_large"),
    ]).toEqual([
      "Saved. Your edited application is waiting for your approval, every answer marked new.",
      "That application isn't waiting any more, so nothing changed.",
      "Northstar couldn't accept those answers. Check them and try again.",
      "Those answers are too long to send at once. Save fewer at a time.",
    ]);
  });
});
