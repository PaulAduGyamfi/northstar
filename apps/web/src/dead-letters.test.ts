import { describe, expect, it } from "vitest";
import { DEAD_LETTER_ACTIONS, letterLine, nextStep, resolveMessage } from "./dead-letters";

// Stuck work's words (NS-215). Synthetic letters only.

const ITEM = {
  deadLetterId: "4d1e2a10-6b2c-4f0e-8a51-7c2b9d0e1f01",
  kind: "apply.stale_sweep",
  reasonCode: "sweep_failed",
  attempts: 3,
  deadAt: "2026-11-26T12:00:00.000Z",
};

describe("letterLine", () => {
  it("says what stopped and why, in words", () => {
    expect(letterLine(ITEM)).toEqual({
      what: "Closing stale application claims",
      why: "Stopped after 3 attempts: every attempt failed",
    });
  });

  it("never finds an object's built-in names as words", () => {
    expect(letterLine({ ...ITEM, kind: "constructor", reasonCode: "constructor" })).toEqual({
      what: "constructor",
      why: "Stopped after 3 attempts: constructor",
    });
  });

  it("shows an unknown kind and reason as themselves", () => {
    expect(
      letterLine({ ...ITEM, kind: "llm.route:story-draft", reasonCode: "held_back", attempts: 1 }),
    ).toEqual({
      what: "llm.route:story-draft",
      why: "Stopped after 1 attempt: held back",
    });
  });
});

describe("letterLine for a submission", () => {
  it("names a submission that gave up, and an activity that failed every attempt", () => {
    expect(
      letterLine({ ...ITEM, kind: "apply.submission", reasonCode: "activity_failed", attempts: 5 }),
    ).toEqual({
      what: "Submitting an application",
      why: "Stopped after 5 attempts: every attempt to run it failed",
    });
  });
});

describe("nextStep", () => {
  it("says what happens next for every action on the sweep", () => {
    expect(DEAD_LETTER_ACTIONS.map((a) => nextStep("apply.stale_sweep", a))).toEqual([
      "Nothing runs now: the sweep already tries again on every pass, every few minutes. If it keeps failing, a new item shows here.",
      "Nothing more is done about this pass. Later passes still run.",
      "Nothing runs now: the sweep keeps trying on its own passes. There's no page for open claims yet, so check the Apply ledger in the database if this keeps happening.",
    ]);
  });

  it("says what happens next for every action on a submission, without claiming a restart", () => {
    expect(DEAD_LETTER_ACTIONS.map((a) => nextStep("apply.submission", a))).toEqual([
      "Nothing runs now: a submission can't be restarted from here yet. The application stays where it is on the Pipeline.",
      "Nothing more is done about this run. The application stays where it is on the Pipeline.",
      "Nothing runs now. Check the application on the Pipeline and your email first: the run may already have sent it, or the job may have closed. Only if it wasn't sent, apply on the job's own page yourself.",
    ]);
  });

  it("names a refused interview detection and each of its reasons", () => {
    const detection = { ...ITEM, kind: "calendar.interview_detection", attempts: 1 };
    const reasons = ["too_many_changes", "daily_limit", "invalid_detection", "unknown_application"];
    expect(reasons.map((reasonCode) => letterLine({ ...detection, reasonCode }))).toEqual(
      [
        "one calendar event changed too many times",
        "too many possible interviews in one day",
        "the calendar event couldn't be stored as it is",
        "its application wasn't found",
      ].map((why) => ({
        what: "Finding interviews on your calendar",
        why: `Stopped after 1 attempt: ${why}`,
      })),
    );
  });

  it("says what happens next for every action on an interview detection, without claiming a rerun now", () => {
    expect(DEAD_LETTER_ACTIONS.map((a) => nextStep("calendar.interview_detection", a))).toEqual([
      "Nothing runs now: the next calendar check looks again. An event that changed too many times stays out, and the daily limit clears after a day.",
      "Nothing more is done about this item. Later calendar checks still run.",
      "Nothing runs now. Check your calendar for the interview yourself: an invite that keeps changing, or many at once, may not be from the company.",
    ]);
  });

  it("names a stuck email for reading and sorting, with each of their reasons", () => {
    const poll = { ...ITEM, kind: "mail.poll", reasonCode: "step_failed", attempts: 3 };
    const sort = { ...ITEM, kind: "mail.classify", attempts: 1 };
    expect([
      letterLine(poll),
      ...["read_failed", "classify_failed", "record_refused"].map((reasonCode) =>
        letterLine({ ...sort, reasonCode }),
      ),
    ]).toEqual([
      {
        what: "Reading new job mail",
        why: "Stopped after 3 attempts: linking it to your applications failed",
      },
      {
        what: "Sorting a job email",
        why: "Stopped after 1 attempt: Gmail wouldn't give the email",
      },
      { what: "Sorting a job email", why: "Stopped after 1 attempt: sorting it failed" },
      {
        what: "Sorting a job email",
        why: "Stopped after 1 attempt: its result couldn't be stored",
      },
    ]);
  });

  it("names a recruiter email it couldn't grade, with each reason", () => {
    const grade = { ...ITEM, kind: "mail.grade", attempts: 1 };
    const reasons = [
      "refused",
      "truncated",
      "invalid_output",
      "read_failed",
      "grade_failed",
      "record_refused",
    ];
    expect(reasons.map((reasonCode) => letterLine({ ...grade, reasonCode }).why)).toEqual([
      "Stopped after 1 attempt: the model declined to read it",
      "Stopped after 1 attempt: the model's answer was cut off",
      "Stopped after 1 attempt: the model's answer was malformed",
      "Stopped after 1 attempt: Gmail wouldn't give the email",
      "Stopped after 1 attempt: grading it failed",
      "Stopped after 1 attempt: its result couldn't be stored",
    ]);
    expect(letterLine(grade).what).toBe("Grading a recruiter email");
  });

  it("names a recruiter email it couldn't prepare a reply for, with each reason", () => {
    const reply = { ...ITEM, kind: "mail.reply", attempts: 1 };
    const reasons = [
      "read_failed",
      "invalid_headers",
      "no_reply_address",
      "file_refused",
      "unknown_grade",
    ];
    expect(reasons.map((reasonCode) => letterLine({ ...reply, reasonCode }).why)).toEqual([
      "Stopped after 1 attempt: Gmail wouldn't give the email",
      "Stopped after 1 attempt: its sender, subject or thread headers can't be replied to safely",
      "Stopped after 1 attempt: it came from a no-reply address",
      "Stopped after 1 attempt: your approval queue refused the reply",
      "Stopped after 1 attempt: its stored grade isn't one this version knows",
    ]);
    expect(letterLine(reply).what).toBe("Preparing a reply to a recruiter email");
  });

  it("names an approved reply it couldn't put in Gmail drafts, with each reason", () => {
    const draft = { ...ITEM, kind: "mail.draft_write", attempts: 1 };
    const reasons = [
      "draft_failed",
      "claims_exhausted",
      "draft_not_found",
      "draft_changed",
      "approval_not_valid",
      "draft_conflict",
    ];
    expect([
      letterLine(draft).what,
      ...reasons.map((reasonCode) => letterLine({ ...draft, reasonCode }).why),
    ]).toEqual([
      "Putting an approved reply in your Gmail drafts",
      "Stopped after 1 attempt: every attempt to write the Gmail draft failed",
      "Stopped after 1 attempt: too many runs stopped part-way",
      "Stopped after 1 attempt: its stored reply wasn't found",
      "Stopped after 1 attempt: its stored reply changed after you approved it",
      "Stopped after 1 attempt: its approval no longer stands",
      "Stopped after 1 attempt: a different Gmail draft is already recorded for this approval",
    ]);
  });

  it("says a retried draft is tried on the next drafts run and a skipped one is left out", () => {
    expect(DEAD_LETTER_ACTIONS.map((a) => nextStep("mail.draft_write", a)).slice(0, 2)).toEqual([
      "The next `funnel drafts` run tries this reply again. A draft already in Gmail isn't added twice.",
      "Later `funnel drafts` runs leave this reply out. Nothing was sent.",
    ]);
  });

  it("names an application it couldn't prepare a follow-up for, with its reasons", () => {
    const nudge = { ...ITEM, kind: "mail.nudge", attempts: 1 };
    expect([
      letterLine(nudge).what,
      letterLine({ ...nudge, reasonCode: "no_reply_address" }).why,
      nextStep("mail.nudge", "skip"),
    ]).toEqual([
      "Preparing a follow-up on an application",
      "Stopped after 1 attempt: it came from a no-reply address",
      "Later `funnel inbox` runs prepare no follow-up on this email.",
    ]);
  });

  it("says a retried reply is tried on the next inbox run and a skipped one gets none", () => {
    expect(DEAD_LETTER_ACTIONS.map((a) => nextStep("mail.reply", a)).slice(0, 2)).toEqual([
      "The next `funnel inbox` run tries to prepare this reply again.",
      "Later `funnel inbox` runs prepare no reply to this email.",
    ]);
  });

  it("says a retried email is tried on the next inbox run and a skipped one is passed over", () => {
    expect(DEAD_LETTER_ACTIONS.map((a) => nextStep("mail.poll", a))).toEqual([
      "The next `funnel inbox` run reads this email again.",
      "Later `funnel inbox` runs pass over this email.",
      "Later `funnel inbox` runs pass over this email. Look through your recent job mail in Gmail yourself: one email in it can't be read here.",
    ]);
  });

  it("names a failed relay pass and says every action only records the choice", () => {
    const relay = { ...ITEM, kind: "apply.signal_relay", reasonCode: "relay_failed", attempts: 3 };
    expect(letterLine(relay)).toEqual({
      what: "Passing your approval decisions to waiting submissions",
      why: "Stopped after 3 attempts: every attempt failed",
    });
    expect(DEAD_LETTER_ACTIONS.map((a) => nextStep("apply.signal_relay", a))).toEqual([
      "Nothing runs now: the relay already tries again every minute. If it keeps failing, a new item shows here.",
      "Nothing more is done about this pass. Later passes still run.",
      "Nothing runs now: the relay keeps trying on its own. If items keep showing here, an approved application may be waiting; check the worker on this page.",
    ]);
  });

  it("names a failed prep write and says blocks already added aren't added twice", () => {
    const prep = { ...ITEM, kind: "calendar.prep_write", reasonCode: "write_failed", attempts: 5 };
    expect(letterLine(prep)).toEqual({
      what: "Adding approved prep blocks to your Northstar calendar",
      why: "Stopped after 5 attempts: every attempt to write to Google Calendar failed",
    });
    expect(DEAD_LETTER_ACTIONS.map((a) => nextStep("calendar.prep_write", a))).toEqual([
      "Nothing runs now: the next time you add prep blocks, this plan is tried again. Blocks already added aren't added twice.",
      "Nothing more is done about this plan. Blocks already added stay on your Northstar calendar.",
      "Nothing runs now. Add the prep blocks to your calendar yourself; any already added stay on your Northstar calendar.",
    ]);
  });

  it("words each prep plan refusal no later run can clear", () => {
    const why = (reasonCode: string) =>
      letterLine({ ...ITEM, kind: "calendar.prep_write", reasonCode, attempts: 1 }).why;
    expect(
      ["plan_not_found", "plan_changed", "approval_not_valid", "rescheduled"].map(why),
    ).toEqual([
      "Stopped after 1 attempt: its stored plan wasn't found",
      "Stopped after 1 attempt: its stored plan changed after you approved it",
      "Stopped after 1 attempt: its approval no longer stands",
      "Stopped after 1 attempt: the interview moved and the old approval couldn't be closed",
    ]);
  });

  it("falls back to plain words for a kind it doesn't know", () => {
    expect(nextStep("other.kind", "retry")).toBe("Sent back to be tried again.");
  });
});

describe("resolveMessage", () => {
  it("treats already resolved as done and names the other refusals", () => {
    expect([resolveMessage("already_resolved"), resolveMessage("x")]).toEqual([
      "That was already resolved.",
      "That didn't work. Try again.",
    ]);
  });
});
