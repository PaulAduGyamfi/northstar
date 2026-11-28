import type { ApprovedReply } from "@northstar/db";
import { err, ok, type Result } from "@northstar/domain";
import type { DraftRefusal, DraftWritten } from "@northstar/gateways";
import { describe, expect, it } from "vitest";
import {
  type DraftLetterReason,
  type DraftsRunDeps,
  type DraftsRunReport,
  draftsCommand,
  lasting,
  runDrafts,
} from "./drafts.js";
import type { LetterRow } from "./inbox.js";

// `funnel drafts` (NS-281 slice 1) on fakes: no database, Google or Gmail. Invented ids only.

const reply = (n: number): ApprovedReply => ({
  requestId: `00000000-0000-4000-8000-00000000000${n}`,
  decisionId: `10000000-0000-4000-8000-00000000000${n}`,
});

type Answer = Result<DraftWritten, DraftRefusal> | Error;

class DraftWriteError extends Error {
  override name = "DraftWriteError";
  constructor(readonly status: number) {
    super(`gmail answered ${status}`);
  }
}
const named = (name: string) => Object.assign(new Error("x"), { name });

function harness(
  approved: ApprovedReply[],
  answers: Record<string, Answer> = {},
  letterRows: LetterRow[] = [],
) {
  const letters: { decisionId: string; reason: DraftLetterReason; key: string }[] = [];
  const written: string[] = [];
  let consents = 0;
  const deps: DraftsRunDeps = {
    approved: async () => approved,
    letters: async () => letterRows,
    recordLetter: async (r, reason, key) => {
      letters.push({ decisionId: r.decisionId, reason, key });
    },
    consent: async () => {
      consents++;
      return async (r) => {
        written.push(r.decisionId);
        const answer = answers[r.decisionId] ?? ok({ kind: "created", draftMessageId: "18c0ffee" });
        if (answer instanceof Error) throw answer;
        return answer;
      };
    },
  };
  return { deps, letters, written, consents: () => consents };
}

describe("runDrafts", () => {
  it("asks no consent when nothing is approved", async () => {
    const h = harness([]);
    const report = await runDrafts(h.deps);
    expect([h.consents(), report.approved, report.stoppedBy]).toEqual([0, 0, null]);
  });

  it("asks consent once and writes each approved reply", async () => {
    const h = harness([reply(1), reply(2)]);
    const report = await runDrafts(h.deps);
    expect([h.consents(), h.written, report.written, report.approved]).toEqual([
      1,
      [reply(1).decisionId, reply(2).decisionId],
      2,
      2,
    ]);
  });

  it("writes nothing new on a second run: the first run's draft comes back as already there", async () => {
    const first = harness([reply(1)]);
    const second = harness([reply(1)], {
      [reply(1).decisionId]: ok({ kind: "already_created", draftMessageId: "18c0ffee" }),
    });
    const a = await runDrafts(first.deps);
    const b = await runDrafts(second.deps);
    expect([a.written, a.alreadyThere, b.written, b.alreadyThere, second.letters]).toEqual([
      1,
      0,
      0,
      1,
      [],
    ]);
  });

  it("holds back a reply another run is writing, one inside its undo window and one held by the guard", async () => {
    const h = harness([reply(1), reply(2), reply(3)], {
      [reply(1).decisionId]: err({ kind: "InProgress", retryAt: new Date(0) }),
      [reply(2).decisionId]: err({
        kind: "NotApproved",
        reason: "UndoWindowOpen",
        retryAt: new Date(0),
      }),
      [reply(3).decisionId]: err({
        kind: "HeldBack",
        by: "kill_switch",
        what: "gmail_drafts",
        retryAt: null,
      }),
    });
    const report = await runDrafts(h.deps);
    expect([report.skipped, report.stuck, h.letters]).toEqual([3, 0, []]);
  });

  it("letters each refusal no later run can clear, by its reason, and carries on", async () => {
    const h = harness([reply(1), reply(2), reply(3), reply(4)], {
      [reply(1).decisionId]: err({ kind: "NotFound" }),
      [reply(2).decisionId]: err({ kind: "ContentMismatch" }),
      [reply(3).decisionId]: err({ kind: "NotApproved", reason: "Withdrawn" }),
    });
    const report = await runDrafts(h.deps);
    expect([h.letters.map((l) => l.reason), report.stuck, report.written]).toEqual([
      ["draft_not_found", "draft_changed", "approval_not_valid"],
      3,
      1,
    ]);
  });

  it("letters a write that throws by the ledger's reason, else as a failed write", async () => {
    const h = harness([reply(1), reply(2), reply(3), reply(4)], {
      [reply(1).decisionId]: named("DraftClaimsExhausted"),
      [reply(2).decisionId]: named("DraftRecordConflict"),
      [reply(3).decisionId]: new DraftWriteError(400),
    });
    const report = await runDrafts(h.deps);
    expect([h.letters.map((l) => l.reason), report.written]).toEqual([
      ["claims_exhausted", "draft_conflict", "draft_failed"],
      1,
    ]);
  });

  it("stops writing, with no letter, when Gmail doesn't answer or is busy", async () => {
    const stops = await Promise.all(
      [0, 429, 503].map(async (status) => {
        const h = harness([reply(1), reply(2)], {
          [reply(1).decisionId]: new DraftWriteError(status),
        });
        const report = await runDrafts(h.deps);
        return [report.stoppedBy, h.written.length, h.letters.length];
      }),
    );
    expect(stops).toEqual([
      ["DraftWriteError", 1, 0],
      ["DraftWriteError", 1, 0],
      ["DraftWriteError", 1, 0],
    ]);
  });

  it("stops writing when the grant lacks gmail.compose", async () => {
    const h = harness([reply(1), reply(2)], {
      [reply(1).decisionId]: ok({ kind: "needs_human", reason: "scope_missing" }),
    });
    const report = await runDrafts(h.deps);
    expect([report.scopeMissing, h.written.length, report.written]).toEqual([true, 1, 0]);
  });

  it("stops writing, with no letter, when consent fails", async () => {
    const h = harness([reply(1)]);
    h.deps.consent = async () => {
      throw named("ComposeConsentError");
    };
    const report = await runDrafts(h.deps);
    expect([report.stoppedBy, h.letters]).toEqual(["ComposeConsentError", []]);
  });

  it("passes over a lettered reply until Paul retries it, then gives its next letter a new key", async () => {
    const id1 = reply(1).decisionId;
    const id2 = reply(2).decisionId;
    const h = harness([reply(1), reply(2)], { [id2]: err({ kind: "NotFound" }) }, [
      { idempotencyKey: `mail.draft_write:${id1}:1`, action: null },
      { idempotencyKey: `mail.draft_write:${id2}:1`, action: "retry" },
    ]);
    const report = await runDrafts(h.deps);
    expect([report.passedOver, h.written, h.letters.map((l) => l.key)]).toEqual([
      1,
      [id2],
      [`mail.draft_write:${id2}:2`],
    ]);
  });

  it("asks no consent when every approved reply is passed over", async () => {
    const id1 = reply(1).decisionId;
    const h = harness([reply(1)], {}, [
      { idempotencyKey: `mail.draft_write:${id1}:1`, action: "skip" },
    ]);
    const report = await runDrafts(h.deps);
    expect([h.consents(), report.passedOver]).toEqual([0, 1]);
  });
});

describe("lasting", () => {
  it("treats a decision for another request as an approval that no longer stands", () => {
    expect(lasting({ kind: "NotApproved", reason: "RequestMismatch" })).toBe("approval_not_valid");
  });
});

const REPORT: DraftsRunReport = {
  approved: 0,
  written: 0,
  alreadyThere: 0,
  skipped: 0,
  passedOver: 0,
  stuck: 0,
  scopeMissing: false,
  stoppedBy: null,
};

async function command(report: Partial<DraftsRunReport> | Error) {
  const printed: string[] = [];
  const code = await draftsCommand({
    print: (l) => printed.push(l),
    runDrafts: async () => {
      if (report instanceof Error) throw report;
      return { ...REPORT, ...report };
    },
  });
  return { code, printed };
}

describe("draftsCommand", () => {
  it("says there is nothing to write and exits 0", async () => {
    expect(await command({})).toEqual({
      code: 0,
      printed: ["No approved replies are waiting to go in your Gmail drafts."],
    });
  });

  it("gives counts, says nothing was sent, and exits 0", async () => {
    expect(await command({ approved: 3, written: 1, alreadyThere: 1, skipped: 1 })).toEqual({
      code: 0,
      printed: [
        "Approved replies put in your Gmail drafts: 1 of 3 (1 already there from an earlier run). Held back for later: 1.",
        "Nothing was sent: open Gmail's Drafts, read each one and send it yourself.",
      ],
    });
  });

  it("says why writing stopped and the Stuck work it left, and exits 1", async () => {
    expect(await command({ approved: 2, stuck: 1, stoppedBy: "DraftWriteError" })).toEqual({
      code: 1,
      printed: [
        "Approved replies put in your Gmail drafts: 0. The rest weren't: Google's consent didn't finish or Gmail didn't answer (DraftWriteError). Run it again later; no draft is written twice.",
        "In Stuck work on /health: 1 new, 0 waiting for you. Retry one there and the next run writes it.",
      ],
    });
  });

  it("says to allow drafts access when the scope is missing, and exits 1", async () => {
    expect(await command({ approved: 1, scopeMissing: true })).toEqual({
      code: 1,
      printed: [
        "Approved replies weren't written: Google didn't grant Gmail drafts access. Allow it on the consent page and run it again.",
      ],
    });
  });

  it("prints only the error's class when the run throws, and exits 1", async () => {
    const thrown = Object.assign(new Error("secret-ish detail jo@acme.example"), {
      name: "DbError",
    });
    expect(await command(thrown)).toEqual({
      code: 1,
      printed: [
        "Writing Gmail drafts stopped: DbError (no details are printed).",
        "Drafts already written stay; run it again to retry. Nothing was sent.",
      ],
    });
  });
});
