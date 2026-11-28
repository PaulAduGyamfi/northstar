import { describe, expect, it } from "vitest";
import { hasPlanPreview, PrepPlanBody, prepPlanLines, RESCHEDULED_LINE } from "./prep-plan";

// A prep plan's lines in the Queue (NS-241 slice 6). Invented times only.

const PLAN: PrepPlanBody = {
  interview: { start: "2026-12-01T15:00:00.000Z", end: "2026-12-01T16:00:00.000Z" },
  // Stored out of order on purpose: the lines put them in time order.
  blocks: [
    { kind: "warm_up", start: "2026-12-01T14:00:00.000Z", end: "2026-12-01T14:15:00.000Z" },
    { kind: "prep", start: "2026-11-30T14:00:00.000Z", end: "2026-11-30T14:45:00.000Z" },
  ],
  rescheduled: false,
};

describe("prepPlanLines", () => {
  it("gives the interview, then each block in time order, in the given zone", () => {
    expect(prepPlanLines(PLAN, "America/New_York")).toEqual([
      "Interview: Tue, Dec 1, 10:00",
      "Prep: Mon, Nov 30, 09:00-09:45",
      "Warm-up: Tue, Dec 1, 09:00-09:15",
    ]);
  });

  it("says when no block fit", () => {
    expect(prepPlanLines({ ...PLAN, blocks: [] }, "UTC")).toEqual([
      "Interview: Tue, Dec 1, 15:00",
      "No prep blocks fit before this interview.",
    ]);
  });

  it("ends with the rescheduled warning when the interview moved", () => {
    expect(prepPlanLines({ ...PLAN, rescheduled: true }, "UTC").at(-1)).toBe(RESCHEDULED_LINE);
  });
});

describe("PrepPlanBody", () => {
  it("refuses a time that isn't ISO, so the page says it couldn't be read", () => {
    const bad = { ...PLAN, interview: { start: "next Tuesday", end: PLAN.interview.end } };
    expect([PrepPlanBody.safeParse(PLAN).success, PrepPlanBody.safeParse(bad).success]).toEqual([
      true,
      false,
    ]);
  });
});

describe("hasPlanPreview", () => {
  it("gives the plan view to a prep plan's request only", () => {
    expect(
      (["prep_plan", "email_reply", "application_package", "answer"] as const).map(hasPlanPreview),
    ).toEqual([true, false, false, false]);
  });
});
