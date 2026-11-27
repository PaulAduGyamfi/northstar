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

function fake(over: Partial<InboxRunDeps> = {}) {
  const pollLetters: { key: string; attempts: number }[] = [];
  const classifyLetters: { id: string; reason: ClassifyLetterReason }[] = [];
  const saved: { id: string; result: ClassificationResult }[] = [];
  const skips: string[][] = [];
  const deps: InboxRunDeps = {
    poll: async (skip) => {
      skips.push([...skip]);
      return POLL;
    },
    pollLetters: async () => [],
    classifyLetters: async () => [],
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
    ungradedRecruiterMail: async () => 0,
    ...over,
  };
  return { deps, pollLetters, classifyLetters, saved, skips };
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

  it("gives up on a message that stops three polls: one letter, and the poll isn't stuck", async () => {
    const f = fake({
      poll: async () => ({ ...POLL, stoppedBy: "TypeError", stoppedAt: id(1) }),
    });
    const r = await runInbox(f.deps);
    expect([r.polls, r.pollLetters, r.pollStoppedBy, f.pollLetters]).toEqual([
      3,
      1,
      null,
      [{ key: `mail.poll:${id(1)}:1`, attempts: 3 }],
    ]);
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
  byRules: 2,
  byModel: 1,
  review: 0,
  verification: 0,
  classifyLetters: 0,
  classifyStoppedBy: null,
  moreWaiting: false,
  recruiterWaiting: 0,
};

async function command(run: () => Promise<InboxRunReport>) {
  const printed: string[] = [];
  const code = await inboxCommand({ print: (l) => printed.push(l), runInbox: run });
  return { code, printed };
}

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

  it("exits 1 on a consent error, printing its fixed words", async () => {
    const { code, printed } = await command(async () => {
      throw new OAuthError("consent was not given");
    });
    expect([code, printed[0]]).toEqual([1, "Inbox run stopped: consent was not given"]);
  });
});
