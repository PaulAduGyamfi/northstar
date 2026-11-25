import type { FunnelMessageRow, ManualRowInput, ReviewDecision } from "@northstar/db";
import { OAuthError } from "@northstar/inbox";
import { describe, expect, it } from "vitest";
import type { BackfillCounts } from "./backfill.js";
import { type CliDeps, main } from "./cli.js";
import type { Baselines } from "./report.js";

// Synthetic data only (the repo is public).
const BASELINES: Baselines = {
  note: "test",
  steps: {
    "applied>responded": { rate: 0.1, source: "assumption" },
    "responded>screen": { rate: 0.6, source: "assumption" },
    "screen>technical": { rate: 0.5, source: "assumption" },
    "technical>onsite": { rate: 0.4, source: "assumption" },
    "onsite>offer": { rate: 0.3, source: "assumption" },
  },
};
const COUNTS: BackfillCounts = {
  listed: 40,
  alreadyKnown: 0,
  notJob: 5,
  ruleClassified: 10,
  modelClassified: 24,
  review: 1,
  deferred: 0,
  modelCalls: 26,
  costUsd: 0.26,
};
const reviewItem: FunnelMessageRow = {
  id: "row-1",
  gmailId: "g-1",
  threadId: "t-1",
  senderDomain: "unknown.example",
  receivedAt: new Date("2026-06-20T07:00:00Z"),
  status: "needs_review",
  kind: null,
  company: null,
  role: null,
  requisition: null,
  stageSignal: null,
  classifiedBy: null,
  reviewReason: "provenance",
  promptVersion: 1,
  model: "claude-opus-5-5",
};

function deps(argv: string[], answers: (string | null)[] = []) {
  const printed: string[] = [];
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const stored: { fileSha256: string; rows: ManualRowInput[] }[] = [];
  const decisions: { id: string; decision: ReviewDecision }[] = [];
  const d: CliDeps = {
    argv,
    print: (l) => printed.push(l),
    ask: async () => (answers.length > 0 ? (answers.shift() ?? null) : null),
    now: () => new Date("2026-11-01T00:00:00Z"),
    baselines: BASELINES,
    runBackfill: async () => COUNTS,
    readText: async () =>
      "company,role,applied_on,stage_reached,outcome\nGlobex,Engineer,2026-03-02,screen,rejected\n",
    setManualRows: async (input) => {
      stored.push(input);
      return { status: "imported", rows: input.rows.length };
    },
    readMessages: async () => [reviewItem],
    readManualRows: async () => [],
    latestFactsCheck: async () => null,
    resolveReview: async (id, decision) => {
      decisions.push({ id, decision });
      return {
        ok: true,
        value: { status: decision.action === "discard" ? "discarded" : "classified" },
      };
    },
    recordEvent: async (type, _reason, payload) => {
      events.push({ type, payload });
    },
  };
  return { d, printed, events, stored, decisions };
}

describe("funnel cli", () => {
  it("backfill prints the counts and cost and records a counts-only event", async () => {
    const { d, printed, events } = deps(["backfill"]);
    expect(await main(d)).toBe(0);
    expect(printed[0]).toBe(
      "Listed 40 (0 already done). Not job mail: 5. By rules: 10. By the model: 24. For your review: 1.",
    );
    expect(printed[1]).toBe("26 model call(s), $0.26.");
    expect(events).toEqual([{ type: "funnel.backfilled", payload: { ...COUNTS } }]);
  });

  it("backfill passes --since and --max-messages through and refuses bad values", async () => {
    const seen: unknown[] = [];
    const { d } = deps(["backfill", "--since", "2026-03-01", "--max-messages", "50"]);
    d.runBackfill = async (o) => {
      seen.push(o);
      return COUNTS;
    };
    await main(d);
    expect(seen).toEqual([{ since: "2026-03-01", maxMessages: 50 }]);
    const bad = deps(["backfill", "--since", "March"]);
    expect(await main(bad.d)).toBe(1);
    expect(bad.printed[0]?.startsWith("usage:")).toBe(true);
  });

  it("a cancelled Google consent stops the backfill with its reason and records nothing", async () => {
    const { d, printed, events } = deps(["backfill"]);
    d.runBackfill = async () => {
      throw new OAuthError("Google consent was not given (access_denied)");
    };
    expect(await main(d)).toBe(1);
    expect(printed[0]).toBe("Backfill stopped: Google consent was not given (access_denied)");
    expect(events).toEqual([]);
  });

  it("an unexpected error is named, never quoted", async () => {
    const { d, printed } = deps(["backfill"]);
    d.runBackfill = async () => {
      throw new TypeError("row contains Globex secret subject");
    };
    await main(d);
    expect(printed[0]).toBe("Backfill stopped: TypeError");
  });

  it("import stores a valid tracker with its file hash", async () => {
    const { d, printed, stored } = deps(["import", "data/tracker.csv"]);
    expect(await main(d)).toBe(0);
    expect(stored[0]?.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]?.rows).toHaveLength(1);
    expect(printed[0]).toBe(
      "Imported 1 row(s) from tracker.csv. Run `funnel report` to see the funnel.",
    );
  });

  it("import refuses a bad tracker by line and stores nothing", async () => {
    const { d, printed, stored } = deps(["import", "data/tracker.csv"]);
    d.readText = async () =>
      "company,role,applied_on,stage_reached,outcome\nGlobex,Engineer,soon,screen,rejected\n";
    expect(await main(d)).toBe(1);
    expect(stored).toEqual([]);
    expect(printed).toEqual([
      "Not imported: tracker.csv has problems. Nothing was changed.",
      "  line 2: applied_on must be a real date YYYY-MM-DD",
    ]);
  });

  it("report prints the funnel and records the leakiest step as a fixed name", async () => {
    const { d, printed, events } = deps(["report"]);
    expect(await main(d)).toBe(0);
    expect(printed).toContain("Leakiest stage: not enough data to say yet.");
    expect(events[0]).toEqual({
      type: "funnel.reported",
      payload: { applications: 0, tooNew: 0, leakiest: null, conflicts: 0 },
    });
  });

  it("hypotheses prints the summary first, then each hypothesis", async () => {
    const { d, printed } = deps(["hypotheses"]);
    await main(d);
    expect(printed[0]?.startsWith("Not enough data yet")).toBe(true);
    expect(printed.some((l) => l.startsWith("H11 Inconsistency: untested."))).toBe(true);
  });

  it("review places an item with Paul's answers and links to the email in Gmail", async () => {
    const { d, printed, decisions } = deps(
      ["review"],
      ["p", "interview_request", "Oscorp", "", "screen"],
    );
    expect(await main(d)).toBe(0);
    expect(printed).toContain("  open it: https://mail.google.com/mail/u/0/#all/g-1");
    expect(decisions).toEqual([
      {
        id: "row-1",
        decision: {
          action: "classify",
          kind: "interview_request",
          company: "Oscorp",
          role: null,
          stageSignal: "screen",
        },
      },
    ]);
    expect(printed.at(-1)).toBe("1 decision(s) saved.");
  });

  it("review skips an item placed without a company and keeps going", async () => {
    const { d, printed, decisions } = deps(["review"], ["p", "rejection", "", "", "none"]);
    await main(d);
    expect(decisions).toEqual([]);
    expect(printed).toContain("  a company is needed to place it; skipped.");
  });

  it("review discards on d and stops when input closes", async () => {
    const { d, decisions } = deps(["review"], ["d"]);
    await main(d);
    expect(decisions).toEqual([{ id: "row-1", decision: { action: "discard" } }]);
  });

  it("prints usage for anything else", async () => {
    const { d, printed } = deps(["nonsense"]);
    expect(await main(d)).toBe(1);
    expect(printed[0]?.startsWith("usage: funnel backfill")).toBe(true);
  });
});
