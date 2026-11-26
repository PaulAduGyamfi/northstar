import { describe, expect, it } from "vitest";
import { checkInBody, type GrowRow, growMessage, reviewLines, trackCard } from "./grow";

// The Grow tab's words (NS-214). Invented tracks only.

const ROW: GrowRow = {
  key: "cloud-cert",
  name: "Cloud certification",
  type: "cert",
  status: "active",
  minutesThisWeek: 45,
  plannedMinutes: 120,
  daysSinceTouched: 3,
  atRisk: false,
  streakWeeks: 2,
  percent: 30,
  percentPerWeekNeeded: 8.5,
};

describe("trackCard", () => {
  it("puts every figure in words", () => {
    expect(trackCard(ROW)).toEqual({
      key: "cloud-cert",
      name: "Cloud certification",
      kind: "Certification",
      status: "Active",
      minutes: "45 of 120 min this week",
      touched: "Last worked on 3 days ago",
      atRisk: null,
      streak: "2 weeks in a row",
      percent: 30,
      pace: "8.5% a week reaches the target date",
    });
  });

  it("says what at risk means, and never mentions a streak that isn't there", () => {
    const card = trackCard({
      ...ROW,
      atRisk: true,
      streakWeeks: 0,
      daysSinceTouched: null,
      plannedMinutes: 0,
      percentPerWeekNeeded: null,
    });
    expect([card.atRisk, card.streak, card.touched, card.minutes, card.pace]).toEqual([
      "At risk: it goes first in next week's plan",
      null,
      "Not worked on yet",
      "45 min this week, none planned",
      null,
    ]);
  });

  it("says today and 1 day plainly", () => {
    expect([
      trackCard({ ...ROW, daysSinceTouched: 0 }).touched,
      trackCard({ ...ROW, daysSinceTouched: 1 }).touched,
      trackCard({ ...ROW, streakWeeks: 1 }).streak,
    ]).toEqual(["Last worked on today", "Last worked on 1 day ago", "1 week in a row"]);
  });
});

describe("reviewLines", () => {
  it("lists what moved, then what wasn't reached, with no guilt words", () => {
    const lines = reviewLines({
      weekStart: "2026-11-16",
      moved: [{ key: "cloud-cert", name: "Cloud certification", minutes: 50, plannedMinutes: 120 }],
      notReached: [{ key: "side-app", name: null }],
    });
    expect([lines, lines.some((l) => /miss|broke|behind|fail/i.test(l))]).toEqual([
      ["Cloud certification: 50 of 120 min", "side-app (no longer a track): not reached this week"],
      false,
    ]);
  });
});

describe("checkInBody", () => {
  const fields = { key: "cloud-cert", minutes: "45", percent: "" };

  it("builds a check-in with the form's idempotency key, percent optional", () => {
    expect([
      checkInBody(fields, "form-0001"),
      checkInBody({ ...fields, percent: "30" }, "form-0001")?.percent,
    ]).toEqual([
      { key: "cloud-cert", minutes: 45, percent: null, idempotencyKey: "form-0001" },
      30,
    ]);
  });

  it("refuses no track, minutes outside 1–600 and a percent outside 0–100", () => {
    expect([
      checkInBody({ ...fields, key: "" }, "form-0001"),
      checkInBody({ ...fields, minutes: "0" }, "form-0001"),
      checkInBody({ ...fields, minutes: "601" }, "form-0001"),
      checkInBody({ ...fields, minutes: "4.5" }, "form-0001"),
      checkInBody({ ...fields, percent: "101" }, "form-0001"),
    ]).toEqual([null, null, null, null, null]);
  });
});

describe("growMessage", () => {
  it("names each refusal plainly, and anything else as a retry", () => {
    expect([
      growMessage("no_plan").startsWith("Last week had no stored plan"),
      growMessage("x"),
    ]).toEqual([true, "That didn't work. Try again."]);
  });
});
