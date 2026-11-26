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

  it("shows an unknown kind and reason as themselves", () => {
    expect(
      letterLine({ ...ITEM, kind: "llm.route:story-draft", reasonCode: "held_back", attempts: 1 }),
    ).toEqual({
      what: "llm.route:story-draft",
      why: "Stopped after 1 attempt: held back",
    });
  });
});

describe("nextStep", () => {
  it("says what happens next for every action on the sweep", () => {
    expect(DEAD_LETTER_ACTIONS.map((a) => nextStep("apply.stale_sweep", a))).toEqual([
      "The sweep runs again by itself every 5 minutes, so it picks these claims up next pass.",
      "Nothing more is done about this pass. Later passes still run.",
      "The claims it couldn't close stay in the Apply ledger for you to look at.",
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
