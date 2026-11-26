import { describe, expect, it } from "vitest";
import { DEFAULT_NUDGE_DAYS, type NudgeCandidate, nudgesDue, parseNudgeDays } from "./follow-up.js";

// Follow-up nudges (RPL-004, NS-237 slice 3). Synthetic ids only.

const NOW = new Date("2026-11-26T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const mailAt = (n: number) => ({
  gmailMessageId: "18c3f0a2b4d6e8f0",
  threadId: "18c3f0a2b4d6e8aa",
  receivedAt: daysAgo(n),
  kind: "confirmation" as const,
});

const app = (over: Partial<NudgeCandidate> = {}): NudgeCandidate => ({
  applicationId: "app-a",
  status: "submitted",
  lastMoveAt: daysAgo(10),
  lastMail: mailAt(9),
  replyFiled: false,
  ...over,
});

const due = (...c: NudgeCandidate[]) =>
  nudgesDue(c, DEFAULT_NUDGE_DAYS, NOW).map((d) => [d.applicationId, d.stage, d.silentDays]);

describe("nudgesDue", () => {
  it("nudges an applied application silent for 7 days, on its newest linked message", () => {
    expect(nudgesDue([app()], DEFAULT_NUDGE_DAYS, NOW)).toEqual([
      {
        applicationId: "app-a",
        stage: "applied",
        gmailMessageId: "18c3f0a2b4d6e8f0",
        threadId: "18c3f0a2b4d6e8aa",
        silentDays: 9,
      },
    ]);
  });

  it("counts silence from the newest of the last move and the last mail", () => {
    expect([
      due(app({ lastMoveAt: daysAgo(3) })),
      due(app({ lastMail: mailAt(6) })),
      due(
        app({
          lastMoveAt: daysAgo(7),
          lastMail: mailAt(8),
        }),
      ),
    ]).toEqual([[], [], [["app-a", "applied", 7]]]);
  });

  it("uses each stage's own days: an interview after 5", () => {
    expect([
      due(
        app({
          status: "in_process",
          lastMoveAt: daysAgo(5),
          lastMail: mailAt(5),
        }),
      ),
      due(
        app({
          status: "confirmed",
          lastMoveAt: daysAgo(5),
          lastMail: mailAt(5),
        }),
      ),
      nudgesDue(
        [
          app({
            lastMoveAt: daysAgo(2),
            lastMail: mailAt(2),
          }),
        ],
        { applied: 2, interview: 5 },
        NOW,
      ).length,
    ]).toEqual([[["app-a", "interview", 5]], [], 1]);
  });

  it("nudges only after a confirmation or a plain note, never on Paul's turn, an ending or an unknown kind", () => {
    const kind = (k: NonNullable<NudgeCandidate["lastMail"]>["kind"]) =>
      due(app({ lastMail: { ...mailAt(9), kind: k } })).length;
    expect([
      kind("confirmation"),
      kind("info_other"),
      kind("scheduling"),
      kind("assessment"),
      kind("recruiter_inbound"),
      kind("rejection"),
      kind("offer"),
      kind(null),
    ]).toEqual([1, 1, 0, 0, 0, 0, 0, 0]);
  });

  it("never nudges with a draft already filed, with no thread, or outside a nudge stage", () => {
    expect([
      due(app({ replyFiled: true })),
      due(app({ lastMail: null })),
      due(app({ status: "awaiting_approval" })),
      due(app({ status: "rejected" })),
      due(app({ status: "offer" })),
    ]).toEqual([[], [], [], [], []]);
  });

  it("puts the longest silent first, then orders by id", () => {
    expect(
      due(
        app({ applicationId: "app-c" }),
        app({
          applicationId: "app-b",
          lastMoveAt: daysAgo(20),
          lastMail: mailAt(20),
        }),
        app({ applicationId: "app-a" }),
      ),
    ).toEqual([
      ["app-b", "applied", 20],
      ["app-a", "applied", 9],
      ["app-c", "applied", 9],
    ]);
  });
});

describe("parseNudgeDays", () => {
  it("takes whole days from 1 to 60 per stage", () => {
    expect(parseNudgeDays({ applied: 1, interview: 60 })).toEqual({
      ok: true,
      value: { applied: 1, interview: 60 },
    });
  });

  it("refuses days outside 1 to 60 or not whole, naming each field", () => {
    expect([
      parseNudgeDays({ applied: 0, interview: 61 }),
      parseNudgeDays({ applied: 2.5, interview: 5 }),
      parseNudgeDays({ applied: 7 }),
    ]).toEqual([
      { ok: false, error: { kind: "InvalidNudgeDays", fields: ["applied", "interview"] } },
      { ok: false, error: { kind: "InvalidNudgeDays", fields: ["applied"] } },
      { ok: false, error: { kind: "InvalidNudgeDays", fields: ["interview"] } },
    ]);
  });
});
