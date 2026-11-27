import { describe, expect, it } from "vitest";
import { queuedRows, regradedMessage, regradeProblem } from "./inbox";

// Paul's regrade words (NS-238 item 3). Synthetic ids only.

describe("regradedMessage and regradeProblem", () => {
  it("say what a regrade did, that a repeat changed nothing, and why one failed", () => {
    expect([
      regradedMessage("D", true),
      regradedMessage("D", false),
      regradeProblem("not_graded"),
      regradeProblem("unavailable"),
      regradeProblem("odd"),
    ]).toEqual([
      "Saved your grade: D. Northstar learns from it; nothing is sent.",
      "Your grade was already D.",
      "That thread has no graded email to regrade.",
      "Northstar couldn't save that right now. Try again.",
      "That didn't go through. Try again.",
    ]);
  });
});

describe("a regraded thread", () => {
  it("reads 'You graded it D' beside the system's grade, and nothing when not regraded", () => {
    const at = "2026-11-25T12:00:00Z";
    const rows = queuedRows(
      [
        {
          gmailThreadId: "cc01",
          gmailUrl: "https://mail.google.com/mail/u/0/#all/cc01",
          messages: 1,
          lastReceivedAt: at,
          reason: "no_match",
          recruiterGrade: { grade: "B", reasons: [], confidence: "normal", paulGrade: "D" },
        },
        {
          gmailThreadId: "cc02",
          gmailUrl: "https://mail.google.com/mail/u/0/#all/cc02",
          messages: 1,
          lastReceivedAt: at,
          reason: "no_match",
          recruiterGrade: { grade: "B", reasons: [], confidence: "normal" },
        },
      ],
      Date.parse("2026-11-25T14:00:00Z"),
    );
    expect(rows.map((r) => r.paulGrade ?? null)).toEqual(["You graded it D", null]);
  });
});
