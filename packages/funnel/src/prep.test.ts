import type { ApprovedPrepPlan, StoredInterview } from "@northstar/db";
import type { PrepRefusal, PrepWritten } from "@northstar/gateways";
import { describe, expect, it } from "vitest";
import {
  type PrepLetterReason,
  type PrepRunDeps,
  type PrepRunReport,
  planLine,
  prepCommand,
  runPrep,
} from "./prep.js";

// `funnel prep` (NS-241 slice 5) with every port faked: no Google, database or browser.
// Invented ids only.

const NOW = new Date("2026-11-27T12:00:00Z");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const interview = (
  n: number,
  decision: StoredInterview["decision"],
  start = new Date("2026-12-01T15:00:00Z"),
): StoredInterview => ({
  detectionId: uuid(n),
  applicationId: uuid(900),
  calendarEventId: `evt${n}`,
  format: "technical",
  start,
  end: new Date(start.getTime() + 60 * 60 * 1000),
  interviewerCount: 1,
  decision,
});

const plan = (n: number): ApprovedPrepPlan => ({
  requestId: uuid(100 + n),
  decisionId: uuid(200 + n),
});

type Answer = { ok: true; value: PrepWritten } | { ok: false; error: PrepRefusal };
const WRITTEN: Answer = { ok: true, value: { kind: "written", created: 3, existing: 0 } };

function fake(over: Partial<PrepRunDeps> = {}) {
  const proposed: string[] = [];
  const filed: string[] = [];
  const written: string[] = [];
  const letters: { decisionId: string; reason: PrepLetterReason; key: string }[] = [];
  let consents = 0;
  const deps: PrepRunDeps = {
    config: { timeZone: "UTC", workingHours: { start: 540, end: 1020 } },
    now: () => NOW,
    interviews: async () => [],
    proposalOf: async () => null,
    propose: async (detectionId) => {
      proposed.push(detectionId);
      return { ok: true, value: { proposalId: `p-${detectionId}`, blocks: [] } };
    },
    file: async (proposalId) => {
      filed.push(proposalId);
      return { ok: true, value: { requestId: uuid(1), replayed: false, stored: true } };
    },
    approved: async () => [],
    letters: async () => [],
    recordLetter: async (p, reason, key) => {
      letters.push({ decisionId: p.decisionId, reason, key });
    },
    consent: async () => {
      consents++;
      return async (p) => {
        written.push(p.decisionId);
        return WRITTEN;
      };
    },
    ...over,
  };
  return { deps, proposed, filed, written, letters, consents: () => consents };
}

describe("runPrep: proposing and filing", () => {
  it("proposes only for confirmed interviews still ahead with no proposal, then files each", async () => {
    const f = fake({
      interviews: async () => [
        interview(1, "confirmed"),
        interview(2, null),
        interview(3, "dismissed"),
        interview(4, "confirmed", new Date("2026-11-27T11:00:00Z")),
        interview(5, "confirmed"),
      ],
      proposalOf: async (id) => (id === uuid(5) ? { proposalId: "p-existing", blocks: [] } : null),
    });
    const r = await runPrep(f.deps);
    expect([f.proposed, f.filed, r.proposed, r.filed]).toEqual([
      [uuid(1)],
      [`p-${uuid(1)}`, "p-existing"],
      1,
      2,
    ]);
  });

  it("passes the zone, the working hours, no busy time and the run's clock to the planner", async () => {
    const seen: unknown[] = [];
    const f = fake({
      interviews: async () => [interview(1, "confirmed")],
      propose: async (_id, request) => {
        seen.push(request);
        return { ok: true, value: { proposalId: "p1", blocks: [] } };
      },
    });
    await runPrep(f.deps);
    expect(seen).toEqual([
      { busy: [], workingHours: { start: 540, end: 1020 }, timeZone: "UTC", now: NOW },
    ]);
  });

  it("counts a refused proposal, an earlier filing and a refused filing apart", async () => {
    const f = fake({
      interviews: async () => [
        interview(1, "confirmed"),
        interview(2, "confirmed"),
        interview(3, "confirmed"),
      ],
      proposalOf: async (id) => (id === uuid(1) ? null : { proposalId: `p-${id}`, blocks: [] }),
      propose: async () => ({ ok: false, error: { kind: "InterviewStarted" } }),
      file: async (proposalId) =>
        proposalId === `p-${uuid(2)}`
          ? { ok: true, value: { requestId: uuid(1), replayed: true, stored: false } }
          : { ok: false, error: { kind: "EmptyPlan" } },
    });
    const r = await runPrep(f.deps);
    expect([r.notProposed, r.waiting, r.notFiled, r.filed]).toEqual([1, 1, 1, 0]);
  });

  it("keeps each newly filed plan's interview time and blocks for Paul's terminal, not earlier ones", async () => {
    const blocks = [
      {
        kind: "prep" as const,
        start: new Date("2026-11-30T09:00:00Z"),
        end: new Date("2026-11-30T09:45:00Z"),
      },
    ];
    const f = fake({
      interviews: async () => [interview(1, "confirmed"), interview(2, "confirmed")],
      propose: async (id) => ({ ok: true, value: { proposalId: `p-${id}`, blocks } }),
      file: async (proposalId) =>
        proposalId === `p-${uuid(1)}`
          ? { ok: true, value: { requestId: uuid(1), replayed: false, stored: true } }
          : { ok: true, value: { requestId: uuid(2), replayed: true, stored: false } },
    });
    const r = await runPrep(f.deps);
    expect([r.timeZone, r.newPlans]).toEqual([
      "UTC",
      [{ interviewStart: new Date("2026-12-01T15:00:00Z"), blocks }],
    ]);
  });
});

describe("runPrep: writing approved plans", () => {
  it("asks no consent when nothing is approved", async () => {
    const f = fake();
    const r = await runPrep(f.deps);
    expect([f.consents(), r.approved, r.written]).toEqual([0, 0, 0]);
  });

  it("asks consent once and writes each approved plan", async () => {
    const f = fake({ approved: async () => [plan(1), plan(2)] });
    const r = await runPrep(f.deps);
    expect([f.consents(), f.written, r.approved, r.written]).toEqual([
      1,
      [uuid(201), uuid(202)],
      2,
      2,
    ]);
  });

  it("counts already written as written and each passing refusal as held back, with no letter", async () => {
    const answers: Answer[] = [
      { ok: true, value: { kind: "already_written", blockCount: 3 } },
      { ok: false, error: { kind: "Rescheduled", withdrawn: true } },
      { ok: false, error: { kind: "InProgress", retryAt: NOW } },
      { ok: false, error: { kind: "NotApproved", reason: "UndoWindowOpen", retryAt: NOW } },
      {
        ok: false,
        error: { kind: "HeldBack", by: "kill_switch", what: "calendar_writes", retryAt: null },
      },
    ];
    const f = fake({
      approved: async () => answers.map((_, i) => plan(i)),
      consent: async () => async () => answers.shift() as Answer,
    });
    const r = await runPrep(f.deps);
    expect([r.written, r.skipped, f.letters]).toEqual([1, 4, []]);
  });

  it("letters each refusal no later run can clear, by its reason, and carries on", async () => {
    const answers: Answer[] = [
      { ok: false, error: { kind: "NotFound" } },
      { ok: false, error: { kind: "ContentMismatch" } },
      { ok: false, error: { kind: "NotApproved", reason: "Rejected" } },
      { ok: false, error: { kind: "Rescheduled", withdrawn: false } },
      WRITTEN,
    ];
    const f = fake({
      approved: async () => answers.map((_, i) => plan(i)),
      consent: async () => async () => answers.shift() as Answer,
    });
    const r = await runPrep(f.deps);
    expect([f.letters.map((l) => l.reason), r.stuck, r.skipped, r.written]).toEqual([
      ["plan_not_found", "plan_changed", "approval_not_valid", "rescheduled"],
      4,
      0,
      1,
    ]);
  });

  it("stops writing when the grant lacks the Northstar calendar scope", async () => {
    let calls = 0;
    const f = fake({
      approved: async () => [plan(1), plan(2)],
      consent: async () => async () => {
        calls++;
        return { ok: true, value: { kind: "needs_human", reason: "scope_missing" } };
      },
    });
    const r = await runPrep(f.deps);
    expect([r.scopeMissing, calls, r.written]).toEqual([true, 1, 0]);
  });

  it("letters a write that fails, by its reason, and carries on with the next plan", async () => {
    class PrepClaimsExhausted extends Error {
      override name = "PrepClaimsExhausted";
    }
    const failures = [new Error("Google answered 500"), new PrepClaimsExhausted()];
    const f = fake({
      approved: async () => [plan(1), plan(2), plan(3)],
      consent: async () => async () => {
        const e = failures.shift();
        if (e) throw e;
        return WRITTEN;
      },
    });
    const r = await runPrep(f.deps);
    expect([f.letters, r.stuck, r.written]).toEqual([
      [
        {
          decisionId: uuid(201),
          reason: "write_failed",
          key: `calendar.prep_write:${uuid(201)}:1`,
        },
        {
          decisionId: uuid(202),
          reason: "claims_exhausted",
          key: `calendar.prep_write:${uuid(202)}:1`,
        },
      ],
      2,
      1,
    ]);
  });

  it("stops writing, with no letter, when Google doesn't answer or is busy", async () => {
    class CalendarWriteError extends Error {
      override name = "CalendarWriteError";
      constructor(readonly status: number) {
        super(`Google answered ${status}`);
      }
    }
    for (const status of [0, 429, 503]) {
      let calls = 0;
      const f = fake({
        approved: async () => [plan(1), plan(2)],
        consent: async () => async () => {
          calls++;
          throw new CalendarWriteError(status);
        },
      });
      const r = await runPrep(f.deps);
      expect([r.writeStoppedBy, calls, f.letters]).toEqual(["CalendarWriteError", 1, []]);
    }
  });

  it("letters a plan Google refused with a 400, since that is about the plan", async () => {
    class CalendarWriteError extends Error {
      override name = "CalendarWriteError";
      constructor(readonly status: number) {
        super(`Google answered ${status}`);
      }
    }
    const f = fake({
      approved: async () => [plan(1)],
      consent: async () => async () => {
        throw new CalendarWriteError(400);
      },
    });
    const r = await runPrep(f.deps);
    expect([r.writeStoppedBy, f.letters.map((l) => l.reason)]).toEqual([null, ["write_failed"]]);
  });

  it("passes over a lettered plan until Paul retries it, then gives its next letter a new key", async () => {
    const f = fake({
      approved: async () => [plan(1), plan(2)],
      letters: async () => [
        { idempotencyKey: `calendar.prep_write:${uuid(201)}:1`, action: "skip" },
        { idempotencyKey: `calendar.prep_write:${uuid(202)}:1`, action: "retry" },
      ],
      consent: async () => async () => {
        throw new Error("Google answered 500");
      },
    });
    const r = await runPrep(f.deps);
    expect([r.passedOver, f.letters.map((l) => l.key)]).toEqual([
      1,
      [`calendar.prep_write:${uuid(202)}:2`],
    ]);
  });

  it("stops writing, with no letter, when consent fails", async () => {
    class CalendarConsentError extends Error {
      override name = "CalendarConsentError";
    }
    const f = fake({
      approved: async () => [plan(1)],
      consent: async () => {
        throw new CalendarConsentError("consent timed out");
      },
    });
    const r = await runPrep(f.deps);
    expect([r.writeStoppedBy, r.approved, f.letters]).toEqual(["CalendarConsentError", 0, []]);
  });
});

const REPORT: PrepRunReport = {
  timeZone: "UTC",
  newPlans: [],
  proposed: 2,
  notProposed: 0,
  filed: 2,
  waiting: 1,
  notFiled: 0,
  approved: 1,
  written: 1,
  skipped: 0,
  passedOver: 0,
  stuck: 0,
  scopeMissing: false,
  writeStoppedBy: null,
};

describe("prepCommand", () => {
  it("prints counts and the next step in fixed words", async () => {
    const printed: string[] = [];
    const code = await prepCommand({ print: (l) => printed.push(l), runPrep: async () => REPORT });
    expect([code, printed]).toEqual([
      0,
      [
        "Prep proposed for 2 interview(s).",
        "Sent to your Queue for approval: 2. Sent on an earlier run: 1. Not sent: 0.",
        "Approved plans written to your Northstar calendar: 1 of 1. Held back for later: 0.",
        "Approve or reject the new plans in your Queue, then run this again.",
      ],
    ]);
  });

  it("says the scope is missing and exits 1", async () => {
    const printed: string[] = [];
    const code = await prepCommand({
      print: (l) => printed.push(l),
      runPrep: async () => ({ ...REPORT, scopeMissing: true }),
    });
    expect([code, printed.at(-1)]).toEqual([
      1,
      "Approved plans weren't written: Google didn't grant calendar access for the Northstar calendar. Allow it on the consent page and run it again.",
    ]);
  });

  it("prints each new plan's interview and block times in Paul's zone", async () => {
    const printed: string[] = [];
    await prepCommand({
      print: (l) => printed.push(l),
      runPrep: async () => ({
        ...REPORT,
        timeZone: "America/New_York",
        newPlans: [
          {
            interviewStart: new Date("2026-12-01T15:00:00Z"),
            blocks: [
              {
                kind: "prep",
                start: new Date("2026-11-30T14:00:00Z"),
                end: new Date("2026-11-30T14:45:00Z"),
              },
              {
                kind: "warm_up",
                start: new Date("2026-12-01T14:00:00Z"),
                end: new Date("2026-12-01T14:15:00Z"),
              },
            ],
          },
        ],
      }),
    });
    expect(printed[2]).toBe(
      "Interview Tue, Dec 1, 10:00: prep Mon, Nov 30, 09:00-09:45; warm-up Tue, Dec 1, 09:00-09:15.",
    );
  });

  it("says a plan with no blocks has none", () => {
    expect(planLine({ interviewStart: new Date("2026-12-01T15:00:00Z"), blocks: [] }, "UTC")).toBe(
      "Interview Tue, Dec 1, 15:00: no blocks fit.",
    );
  });

  it("says why writing stopped, and the Stuck work it left, and exits 1", async () => {
    const printed: string[] = [];
    const code = await prepCommand({
      print: (l) => printed.push(l),
      runPrep: async () => ({
        ...REPORT,
        filed: 0,
        written: 0,
        stuck: 1,
        writeStoppedBy: "CalendarWriteError",
      }),
    });
    expect([code, printed.slice(2)]).toEqual([
      1,
      [
        "Written to your Northstar calendar: 0. The rest wasn't: Google's consent didn't finish or Google didn't answer (CalendarWriteError). Run it again later; nothing is written twice.",
        "In Stuck work on /health: 1 new, 0 waiting for you. Retry one there and the next run writes it.",
      ],
    ]);
  });

  it("names the Stuck work even when the scope is missing", async () => {
    const printed: string[] = [];
    await prepCommand({
      print: (l) => printed.push(l),
      runPrep: async () => ({ ...REPORT, filed: 0, scopeMissing: true, passedOver: 2 }),
    });
    expect(printed.at(-1)).toBe(
      "In Stuck work on /health: 0 new, 2 waiting for you. Retry one there and the next run writes it.",
    );
  });

  it("prints only the error's name when the run throws, never its message", async () => {
    const printed: string[] = [];
    const code = await prepCommand({
      print: (l) => printed.push(l),
      runPrep: async () => {
        throw new TypeError("secret-looking detail");
      },
    });
    expect([code, printed]).toEqual([
      1,
      [
        "Interview prep stopped: TypeError (no details are printed)",
        "What was saved stays; run it again to retry.",
      ],
    ]);
  });
});
