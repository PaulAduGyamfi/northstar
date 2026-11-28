import type { ClassificationResult, UnclassifiedMail } from "@northstar/db";
import {
  type FullMessage,
  GmailError,
  type MailPollReport,
  OAuthError,
  type TriageResult,
} from "@northstar/inbox";
import { HeldBack, LlmTransportError } from "@northstar/llm";
import { describe, expect, it } from "vitest";
import { FunnelConfigError } from "./config.js";
import {
  type ClassifyLetterReason,
  type InboxRunDeps,
  type InboxRunReport,
  inboxCommand,
  letterKey,
  letterState,
  MAX_CLASSIFY,
  runInbox,
  storedResult,
} from "./inbox.js";
import type { NudgeReport } from "./nudge.js";
import type { ReplyReport } from "./reply.js";

// `funnel inbox` (NS-238 item 1) with every port faked: no Gmail, model or database. Invented
// Gmail ids only.

const POLL: MailPollReport = {
  listed: 3,
  handled: 3,
  linked: 1,
  queued: 1,
  skipped: 0,
  notJobMail: 1,
  passedOver: 0,
  truncated: false,
  nextSince: new Date("2026-11-27T12:00:00Z"),
  nextOverlap: true,
  stoppedBy: null,
  stoppedAt: null,
};

const id = (n: number) => `18c3f0a2b4d6e${String(n).padStart(3, "0")}`;
const row = (n: number): UnclassifiedMail => ({
  mailLinkId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  gmailMessageId: id(n),
});
const mail = (gmailId: string): FullMessage => ({ id: gmailId }) as unknown as FullMessage;

const RULES: TriageResult = {
  kind: "classified",
  by: "rules",
  classification: {
    kind: "confirmation",
    company: "Globex",
    role: null,
    requisition: null,
    stageSignal: "none",
  },
};

// The reply step turned off, as it is by default.
const NUDGES_OFF: NudgeReport = {
  enabled: false,
  filed: 0,
  answered: 0,
  nudgeLetters: 0,
  nudgeStoppedBy: null,
  moreToNudge: false,
};

const REPLIES_OFF: ReplyReport = {
  enabled: false,
  filed: 0,
  answered: 0,
  archiveSuggested: 0,
  replyLetters: 0,
  replyStoppedBy: null,
  moreToReply: false,
};

function fake(over: Partial<InboxRunDeps> = {}) {
  const pollLetters: { key: string; attempts: number }[] = [];
  const classifyLetters: { id: string; reason: ClassifyLetterReason }[] = [];
  const saved: { id: string; result: ClassificationResult }[] = [];
  const skips: string[][] = [];
  const relinked: string[] = [];
  const leftAlone: string[] = [];
  const deps: InboxRunDeps = {
    poll: async (skip) => {
      skips.push([...skip]);
      return POLL;
    },
    pollLetters: async () => [],
    classifyLetters: async () => [],
    relink: async (gmailId) => {
      relinked.push(gmailId);
    },
    recorded: async () => new Set(),
    recordPollLetter: async (key, attempts) => {
      pollLetters.push({ key, attempts });
    },
    recordClassifyLetter: async (m, reason) => {
      classifyLetters.push({ id: m.gmailMessageId, reason });
    },
    unclassified: async () => [],
    readFull: async (gmailId) => mail(gmailId),
    classify: async () => RULES,
    recordClassification: async (gmailId, result) => {
      saved.push({ id: gmailId, result });
      return { ok: true };
    },
    recordSkipped: async (gmailId) => {
      leftAlone.push(gmailId);
      return { ok: true };
    },
    ungradedRecruiterMail: async () => 0,
    grading: async () => ({
      enabled: false,
      graded: 0,
      gradeLetters: 0,
      gradeStoppedBy: null,
      moreToGrade: false,
    }),
    replies: async () => REPLIES_OFF,
    nudges: async () => NUDGES_OFF,
    ...over,
  };
  return { deps, pollLetters, classifyLetters, saved, skips, relinked, leftAlone };
}

describe("runInbox: linking new mail", () => {
  it("polls once when the poll finishes, and passes over messages with an open letter", async () => {
    const f = fake({
      pollLetters: async () => [{ idempotencyKey: `mail.poll:${id(9)}:1`, action: null }],
    });
    const r = await runInbox(f.deps);
    expect([r.polls, r.linked, r.queued, r.pollStoppedBy, f.skips]).toEqual([
      1,
      1,
      1,
      null,
      [[id(9)]],
    ]);
  });

  it("gives up on a message that stops three polls, then polls once more past it", async () => {
    // This poll replaces the fake's own, so it notes each skip set itself.
    const skips: string[][] = [];
    const f = fake({
      // Stops at id(1) until it is passed over.
      poll: async (skip) => {
        skips.push([...skip]);
        return skip.has(id(1))
          ? { ...POLL, passedOver: 1 }
          : { ...POLL, stoppedBy: "TypeError", stoppedAt: id(1) };
      },
    });
    const r = await runInbox(f.deps);
    expect([r.polls, r.pollLetters, r.pollStoppedBy, f.pollLetters, skips.at(-1)]).toEqual([
      4,
      1,
      null,
      [{ key: `mail.poll:${id(1)}:1`, attempts: 3 }],
      [id(1)],
    ]);
  });

  it("reads again each message Paul sent back with Retry, unless it is already recorded", async () => {
    const f = fake({
      pollLetters: async () => [
        { idempotencyKey: `mail.poll:${id(1)}:1`, action: "retry" },
        { idempotencyKey: `mail.poll:${id(2)}:1`, action: "retry" },
        { idempotencyKey: `mail.poll:${id(3)}:1`, action: "skip" },
      ],
      recorded: async () => new Set([id(2)]),
    });
    const r = await runInbox(f.deps);
    expect([f.relinked, r.relinked, f.skips[0]]).toEqual([[id(1)], 1, [id(3)]]);
  });

  it("gives a retried message that fails again a new letter and passes over it", async () => {
    const f = fake({
      pollLetters: async () => [{ idempotencyKey: `mail.poll:${id(1)}:1`, action: "retry" }],
      relink: async () => {
        throw new TypeError("bad");
      },
    });
    const r = await runInbox(f.deps);
    expect([f.pollLetters, r.pollLetters, f.skips[0]]).toEqual([
      [{ key: `mail.poll:${id(1)}:2`, attempts: 1 }],
      1,
      [id(1)],
    ]);
  });

  it("stops linking, with no letter, when Gmail fails on a retried message", async () => {
    const f = fake({
      pollLetters: async () => [{ idempotencyKey: `mail.poll:${id(1)}:1`, action: "retry" }],
      relink: async () => {
        throw new GmailError("Gmail answered 503", 503);
      },
    });
    const r = await runInbox(f.deps);
    expect([r.polls, f.pollLetters, r.pollStoppedBy]).toEqual([0, [], "GmailError"]);
  });

  it("records no letter when different messages stop it, and reports the stop", async () => {
    let n = 0;
    const f = fake({
      poll: async () => ({ ...POLL, stoppedBy: "TypeError", stoppedAt: id(++n) }),
    });
    const r = await runInbox(f.deps);
    expect([r.polls, r.pollLetters, r.pollStoppedBy]).toEqual([3, 0, "TypeError"]);
  });

  it("stops at once, with no letter, when Gmail, the token or a breaker failed", async () => {
    for (const stoppedBy of ["HeldBack", "GmailError", "OAuthError", "FutureCursorError"]) {
      const f = fake({ poll: async () => ({ ...POLL, stoppedBy, stoppedAt: id(1) }) });
      const r = await runInbox(f.deps);
      expect([r.polls, r.pollLetters, r.pollStoppedBy]).toEqual([1, 0, stoppedBy]);
    }
  });

  it("still classifies when the listing fails", async () => {
    const f = fake({
      poll: async () => {
        throw new GmailError("Gmail answered 503", 503);
      },
      unclassified: async () => [row(1)],
    });
    const r = await runInbox(f.deps);
    expect([r.polls, r.pollStoppedBy, r.byRules]).toEqual([0, "GmailError", 1]);
  });
});

describe("runInbox: classifying recorded mail", () => {
  it("stores codes only, by rules or by the model, and sends nothing for verification mail", async () => {
    const results: TriageResult[] = [
      RULES,
      {
        kind: "classified",
        by: "model",
        classification: {
          kind: "rejection",
          company: "Globex",
          role: null,
          requisition: null,
          stageSignal: "none",
        },
        stamp: { promptVersion: 2, model: "claude-opus-5-5" },
      },
      {
        kind: "review",
        reason: "provenance",
        stamp: { promptVersion: 2, model: "claude-opus-5-5" },
      },
      { kind: "skip", reason: "verification" },
    ];
    const f = fake({
      unclassified: async () => [row(1), row(2), row(3), row(4)],
      classify: async () => results.shift() as TriageResult,
    });
    const r = await runInbox(f.deps);
    expect([r.byRules, r.byModel, r.review, r.verification, r.moreWaiting]).toEqual([
      1,
      1,
      1,
      1,
      false,
    ]);
    expect(f.saved).toEqual([
      {
        id: id(1),
        result: {
          outcome: "classified",
          kind: "confirmation",
          stageSignal: "none",
          decidedBy: "rules",
        },
      },
      {
        id: id(2),
        result: {
          outcome: "classified",
          kind: "rejection",
          stageSignal: "none",
          decidedBy: "model",
          promptVersion: 2,
        },
      },
      { id: id(3), result: { outcome: "review", reason: "provenance", promptVersion: 2 } },
    ]);
  });

  it("classifies at most 25 a run, leaving out lettered messages, and says more wait", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(i + 1));
    let asked = 0;
    const f = fake({
      classifyLetters: async () => [{ idempotencyKey: `mail.classify:${id(1)}:1`, action: null }],
      unclassified: async (limit) => {
        asked = limit;
        return rows.slice(0, limit);
      },
    });
    const r = await runInbox(f.deps);
    expect([asked, f.saved.length, f.saved[0]?.id, r.moreWaiting]).toEqual([
      MAX_CLASSIFY + 2,
      MAX_CLASSIFY,
      id(2),
      true,
    ]);
  });

  it("letters a message Gmail no longer has, and one the classifier throws on, then carries on", async () => {
    const f = fake({
      unclassified: async () => [row(1), row(2), row(3)],
      readFull: async (gmailId) => {
        if (gmailId === id(1)) throw new GmailError("Gmail answered 404", 404);
        return mail(gmailId);
      },
      classify: async (m) => {
        if ((m as unknown as { id: string }).id === id(2)) throw new TypeError("bad");
        return RULES;
      },
    });
    const r = await runInbox(f.deps);
    expect([f.classifyLetters, r.classifyLetters, r.byRules, r.classifyStoppedBy]).toEqual([
      [
        { id: id(1), reason: "read_failed" },
        { id: id(2), reason: "classify_failed" },
      ],
      2,
      1,
      null,
    ]);
  });

  it("stops sorting when the model is held back or doesn't answer, with no letter", async () => {
    for (const error of [
      new HeldBack("kill_switch", "agent:mail-classify"),
      new LlmTransportError({ status: 503, retryable: true }),
    ]) {
      const f = fake({
        unclassified: async () => [row(1), row(2)],
        classify: async () => {
          throw error;
        },
      });
      const r = await runInbox(f.deps);
      expect([r.classifyStoppedBy, f.classifyLetters, r.moreWaiting]).toEqual([
        error.name,
        [],
        true,
      ]);
    }
  });

  it("letters a classification the store refuses", async () => {
    const f = fake({
      unclassified: async () => [row(1)],
      recordClassification: async () => ({ ok: false }),
    });
    const r = await runInbox(f.deps);
    expect([f.classifyLetters, r.byRules]).toEqual([[{ id: id(1), reason: "record_refused" }], 0]);
  });

  it("counts recruiter mail waiting for a grade", async () => {
    const r = await runInbox(fake({ ungradedRecruiterMail: async () => 4 }).deps);
    expect(r.recruiterWaiting).toBe(4);
  });
});

describe("letterState", () => {
  it("passes over a message unless Paul sent its newest letter back with Retry", () => {
    const { passOver } = letterState(
      [
        { idempotencyKey: `mail.poll:${id(1)}:1`, action: null },
        { idempotencyKey: `mail.poll:${id(2)}:1`, action: "skip" },
        { idempotencyKey: `mail.poll:${id(3)}:1`, action: "hand_off" },
        { idempotencyKey: `mail.poll:${id(4)}:1`, action: "retry" },
        { idempotencyKey: `mail.poll:${id(5)}:1`, action: "retry" },
        { idempotencyKey: `mail.poll:${id(5)}:2`, action: null },
        { idempotencyKey: `mail.classify:${id(6)}:1`, action: null },
      ],
      "mail.poll",
    );
    expect([...passOver].sort()).toEqual([id(1), id(2), id(3), id(5)]);
  });

  it("gives a message that failed again after a Retry a new key", () => {
    const { count } = letterState(
      [
        { idempotencyKey: `mail.poll:${id(1)}:1`, action: "retry" },
        { idempotencyKey: `mail.poll:${id(1)}:2`, action: "retry" },
      ],
      "mail.poll",
    );
    expect([letterKey("mail.poll", id(1), count), letterKey("mail.poll", id(2), count)]).toEqual([
      `mail.poll:${id(1)}:3`,
      `mail.poll:${id(2)}:1`,
    ]);
  });
});

describe("runInbox: verification mail (NS-271)", () => {
  it("stores that a verification email was left alone and classifies nothing for it", async () => {
    const f = fake({
      unclassified: async () => [row(1)],
      classify: async () => ({ kind: "skip", reason: "verification" }),
    });
    const r = await runInbox(f.deps);
    expect([f.leftAlone, f.saved, r.verification, r.classifyLetters]).toEqual([[id(1)], [], 1, 0]);
  });

  it("letters a verification email whose outcome couldn't be stored", async () => {
    const f = fake({
      unclassified: async () => [row(1)],
      classify: async () => ({ kind: "skip", reason: "verification" }),
      recordSkipped: async () => ({ ok: false }),
    });
    const r = await runInbox(f.deps);
    expect([f.classifyLetters, r.verification, r.classifyLetters]).toEqual([
      [{ id: id(1), reason: "record_refused" }],
      0,
      1,
    ]);
  });
});

describe("storedResult", () => {
  it("keeps codes only, never the company, role or requisition", () => {
    expect(JSON.stringify(storedResult(RULES))).not.toContain("Globex");
  });
});

const REPORT: InboxRunReport = {
  polls: 1,
  listed: 12,
  linked: 2,
  queued: 1,
  skipped: 0,
  notJobMail: 9,
  passedOver: 0,
  truncated: false,
  pollStoppedBy: null,
  pollLetters: 0,
  relinked: 0,
  byRules: 2,
  byModel: 1,
  review: 0,
  verification: 0,
  classifyLetters: 0,
  classifyStoppedBy: null,
  moreWaiting: false,
  recruiterWaiting: 0,
  gradingOn: false,
  graded: 0,
  gradeLetters: 0,
  gradeStoppedBy: null,
  repliesOn: false,
  repliesFiled: 0,
  repliesAnswered: 0,
  archiveSuggested: 0,
  replyLetters: 0,
  replyStoppedBy: null,
  moreToReply: false,
  nudgesOn: false,
  nudgesFiled: 0,
  nudgesAnswered: 0,
  nudgeLetters: 0,
  nudgeStoppedBy: null,
  moreToNudge: false,
};

async function command(run: () => Promise<InboxRunReport>) {
  const printed: string[] = [];
  const code = await inboxCommand({ print: (l) => printed.push(l), runInbox: run });
  return { code, printed };
}

describe("runInbox: grading", () => {
  it("carries the grading step's counts into the report, after sorting", async () => {
    const order: string[] = [];
    const r = await runInbox(
      fake({
        unclassified: async () => {
          order.push("sort");
          return [];
        },
        grading: async () => {
          order.push("grade");
          return {
            enabled: true,
            graded: 2,
            gradeLetters: 1,
            gradeStoppedBy: null,
            moreToGrade: false,
          };
        },
      }).deps,
    );
    expect([order, r.gradingOn, r.graded, r.gradeLetters]).toEqual([["sort", "grade"], true, 2, 1]);
  });
});

describe("runInbox: replies", () => {
  it("files replies after grading and carries their counts into the report", async () => {
    const order: string[] = [];
    const r = await runInbox(
      fake({
        grading: async () => {
          order.push("grade");
          return {
            enabled: true,
            graded: 1,
            gradeLetters: 0,
            gradeStoppedBy: null,
            moreToGrade: false,
          };
        },
        replies: async () => {
          order.push("reply");
          return {
            enabled: true,
            filed: 2,
            answered: 1,
            archiveSuggested: 0,
            replyLetters: 1,
            replyStoppedBy: null,
            moreToReply: false,
          };
        },
      }).deps,
    );
    expect([order, r.repliesOn, r.repliesFiled, r.repliesAnswered, r.replyLetters]).toEqual([
      ["grade", "reply"],
      true,
      2,
      1,
      1,
    ]);
  });
});

describe("runInbox: follow-up nudges", () => {
  it("files nudges after the replies and reports what they did", async () => {
    const order: string[] = [];
    const r = await runInbox(
      fake({
        replies: async () => {
          order.push("reply");
          return REPLIES_OFF;
        },
        nudges: async () => {
          order.push("nudge");
          return {
            enabled: true,
            filed: 2,
            answered: 1,
            nudgeLetters: 1,
            nudgeStoppedBy: null,
            moreToNudge: true,
          };
        },
      }).deps,
    );
    expect([
      order,
      r.nudgesOn,
      r.nudgesFiled,
      r.nudgesAnswered,
      r.nudgeLetters,
      r.moreToNudge,
    ]).toEqual([["reply", "nudge"], true, 2, 1, 1, true]);
  });
});

describe("inboxCommand", () => {
  it("prints counts only and exits 0", async () => {
    const { code, printed } = await command(async () => REPORT);
    expect([code, printed]).toEqual([
      0,
      [
        "New mail: 12 listed. Linked to an application: 2. Waiting for you to link: 1. Not job mail: 9. Skipped: 0.",
        "Sorted: 3 (2 by rules, 1 by the model). For your review: 0. Verification mail left alone: 0.",
        "Link or review them on /inbox.",
      ],
    ]);
  });

  it("says what follow-ups were filed, where stuck ones wait, and that nothing was sent", async () => {
    const { code, printed } = await command(async () => ({
      ...REPORT,
      queued: 0,
      nudgesOn: true,
      nudgesFiled: 2,
      nudgesAnswered: 1,
      nudgeLetters: 1,
      moreToNudge: true,
    }));
    expect([code, printed.slice(2)]).toEqual([
      0,
      [
        "Follow-ups sent to your Queue for approval: 2. Already followed up by you: 1.",
        "Couldn't prepare a follow-up: 1. Each is in Stuck work on /health.",
        "More applications are due a follow-up; run it again later.",
        "Read and approve the replies on /approvals. Nothing was sent.",
      ],
    ]);
  });

  it("exits 1 and says why when follow-ups stopped early", async () => {
    const { code, printed } = await command(async () => ({
      ...REPORT,
      nudgesOn: true,
      nudgeStoppedBy: "GmailError",
    }));
    expect([code, printed.filter((l) => l.includes("stopped early"))]).toEqual([
      1,
      ["Preparing follow-ups stopped early: Gmail didn't answer."],
    ]);
  });

  it("exits 1 and says why when reading or sorting stopped early", async () => {
    const { code, printed } = await command(async () => ({
      ...REPORT,
      pollStoppedBy: "GmailError",
      classifyStoppedBy: "HeldBack",
    }));
    expect([code, printed.filter((l) => l.includes("stopped early"))]).toEqual([
      1,
      [
        "Reading new mail stopped early: Gmail didn't answer.",
        "Sorting stopped early: a switch, breaker or the spend cap is holding it back.",
      ],
    ]);
  });

  it("says where stuck messages wait and counts recruiter mail waiting for a grade", async () => {
    const { printed } = await command(async () => ({
      ...REPORT,
      pollLetters: 1,
      classifyLetters: 2,
      recruiterWaiting: 3,
    }));
    expect(printed.filter((l) => l.includes("/health") || l.includes("grade"))).toEqual([
      "Passed over: 1 message(s) that kept failing. Each is in Stuck work on /health.",
      "Couldn't sort: 2. Each is in Stuck work on /health.",
      "Recruiter emails waiting for a grade: 3. Grading starts once recruiter reading is turned on.",
    ]);
  });

  it("says how many it graded and where the ones it couldn't grade wait, when grading is on", async () => {
    const { code, printed } = await command(async () => ({
      ...REPORT,
      gradingOn: true,
      graded: 2,
      gradeLetters: 1,
      recruiterWaiting: 3,
    }));
    expect([code, printed.filter((l) => /grade/i.test(l))]).toEqual([
      0,
      [
        "Graded recruiter emails: 2.",
        "Couldn't grade: 1. Each is in Stuck work on /health.",
        "Recruiter emails still to grade: 3; run it again later.",
        "See the grades on /inbox.",
      ],
    ]);
  });

  it("exits 1 when grading stopped early", async () => {
    const { code, printed } = await command(async () => ({
      ...REPORT,
      gradingOn: true,
      gradeStoppedBy: "LlmTransportError",
    }));
    expect([code, printed.filter((l) => l.startsWith("Grading stopped"))]).toEqual([
      1,
      ["Grading stopped early: the Claude API didn't answer."],
    ]);
  });

  it("says how many replies wait in the Queue and that nothing was sent, when replies are on", async () => {
    const { code, printed } = await command(async () => ({
      ...REPORT,
      repliesOn: true,
      repliesFiled: 2,
      repliesAnswered: 1,
      archiveSuggested: 1,
      replyLetters: 1,
    }));
    expect([code, printed.filter((l) => /repl/i.test(l))]).toEqual([
      0,
      [
        "Replies to recruiters sent to your Queue for approval: 2. Already answered by you: 1.",
        "No reply suggested (graded F, archive them): 1.",
        "Couldn't prepare a reply: 1. Each is in Stuck work on /health.",
        "Read and approve the replies on /approvals. Nothing was sent.",
      ],
    ]);
  });

  it("exits 1 when preparing replies stopped early", async () => {
    const { code, printed } = await command(async () => ({
      ...REPORT,
      repliesOn: true,
      replyStoppedBy: "GmailError",
    }));
    expect([code, printed.filter((l) => l.startsWith("Preparing replies"))]).toEqual([
      1,
      ["Preparing replies stopped early: Gmail didn't answer."],
    ]);
  });

  it("exits 1 on a bad RECRUITER_EXTRACT, naming the setting", async () => {
    const { code, printed } = await command(async () => {
      throw new FunnelConfigError("RECRUITER_EXTRACT must be on or off");
    });
    expect([code, printed[0]]).toEqual([
      1,
      "Inbox run stopped: RECRUITER_EXTRACT must be on or off",
    ]);
  });

  it("exits 1 on a consent error, printing its fixed words", async () => {
    const { code, printed } = await command(async () => {
      throw new OAuthError("consent was not given");
    });
    expect([code, printed[0]]).toEqual([1, "Inbox run stopped: consent was not given"]);
  });
});
