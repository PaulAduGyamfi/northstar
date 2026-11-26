import { describe, expect, it } from "vitest";
import { DEFAULT_PLAN_SETTINGS, type GrowthTrack, planWeek, type WeekPlan } from "./growth.js";
import {
  applyCheckIns,
  type CheckIn,
  parseCheckIn,
  trackDashboard,
  weeklyReview,
  weekStartOf,
} from "./growth-progress.js";

// Growth check-ins, dashboard figures and the weekly review (NS-172, GRW-005…007). Synthetic
// tracks only.
const DAY = 86_400_000;
const WEEK_START = new Date("2026-11-23T00:00:00Z"); // a Monday
const NOW = new Date("2026-11-25T12:00:00Z");
const at = (daysFromWeekStart: number) => new Date(WEEK_START.getTime() + daysFromWeekStart * DAY);

const track = (id: string, over: Partial<GrowthTrack> = {}): GrowthTrack => ({
  id,
  name: `Track ${id.toUpperCase()}`,
  type: "project",
  status: "active",
  priority: 3,
  targetDate: null,
  lastTouchedAt: at(-2),
  untouchedDays: 7,
  nextAction: { title: "Next step", minutes: 45 },
  ...over,
});

const checkIn = (
  trackId: string,
  day: number,
  minutes: number,
  percent: number | null = null,
): CheckIn => ({
  trackId,
  at: at(day),
  minutes,
  percent,
});

const plan = (focus: [string, number[]][], maintenance: [string, number[]][] = []): WeekPlan => ({
  focus: focus.map(([trackId, blocks]) => ({ trackId, blocks })),
  maintenance: maintenance.map(([trackId, blocks]) => ({ trackId, blocks })),
  atRisk: [],
  needsNextAction: [],
  notes: [],
  unplanned: [],
});

describe("parseCheckIn (GRW-005)", () => {
  it("accepts a 10-second check-in: track, time, minutes, optional percent", () => {
    const r = parseCheckIn({ trackId: "a", at: NOW, minutes: 30, percent: null });
    expect(r).toEqual({ ok: true, value: { trackId: "a", at: NOW, minutes: 30, percent: null } });
  });

  it("refuses minutes outside 1–600 or a percent outside 0–100, naming the field", () => {
    const fields = [
      { trackId: "a", at: NOW, minutes: 0, percent: null },
      { trackId: "a", at: NOW, minutes: 601, percent: null },
      { trackId: "a", at: NOW, minutes: 30, percent: 101 },
      { trackId: "a", at: NOW, minutes: 30, percent: -1 },
    ].map((input) => {
      const r = parseCheckIn(input);
      return r.ok ? "ok" : r.error.fields[0];
    });
    expect(fields).toEqual(["minutes", "minutes", "percent", "percent"]);
  });
});

describe("applyCheckIns", () => {
  it("moves lastTouchedAt forward to the newest check-in, and never back", () => {
    const tracks = [track("a", { lastTouchedAt: at(-2) }), track("b", { lastTouchedAt: at(2) })];
    const updated = applyCheckIns(tracks, [
      checkIn("a", 1, 30),
      checkIn("a", 0, 30),
      checkIn("b", 0, 30),
    ]);
    expect(updated.map((t) => t.lastTouchedAt?.toISOString())).toEqual([
      at(1).toISOString(),
      at(2).toISOString(),
    ]);
  });

  it("takes a track out of at risk in the next plan once it has a check-in", () => {
    const stale = track("s", { lastTouchedAt: at(-30) });
    expect(planWeek([stale], DEFAULT_PLAN_SETTINGS, NOW).atRisk).toEqual(["s"]);
    const touched = applyCheckIns([stale], [checkIn("s", 1, 20)]);
    expect(planWeek(touched, DEFAULT_PLAN_SETTINGS, NOW).atRisk).toEqual([]);
  });
});

describe("trackDashboard (GRW-006)", () => {
  it("counts only this week's minutes against the plan's minutes for that track", () => {
    const rows = trackDashboard(
      [track("a")],
      [checkIn("a", -1, 50), checkIn("a", 0, 30), checkIn("a", 2, 45)],
      plan([["a", [60, 60]]]),
      WEEK_START,
      NOW,
    );
    expect(rows.map((r) => [r.trackId, r.minutesThisWeek, r.plannedMinutes])).toEqual([
      ["a", 75, 120],
    ]);
  });

  it("leaves a check-in exactly at the week's end to the next week", () => {
    const rows = trackDashboard([track("a")], [checkIn("a", 7, 40)], plan([]), WEEK_START, at(7));
    expect(rows[0]?.minutesThisWeek).toBe(0);
  });

  it("never marks a paused, backlogged or done track at risk, however long untouched (GRW-004)", () => {
    const old = at(-60);
    const rows = trackDashboard(
      [
        track("p", { status: "paused", lastTouchedAt: old }),
        track("b", { status: "backlogged", lastTouchedAt: old }),
        track("d", { status: "done", lastTouchedAt: null }),
      ],
      [],
      plan([]),
      WEEK_START,
      NOW,
    );
    expect(rows.map((r) => r.atRisk)).toEqual([false, false, false]);
  });

  it("never shows negative days for a check-in dated after now", () => {
    const rows = trackDashboard([track("a")], [checkIn("a", 5, 20)], plan([]), WEEK_START, NOW);
    expect(rows[0]?.daysSinceTouched).toBe(0);
  });

  it("says how many whole days since the track was last touched, and whether it's at risk", () => {
    const rows = trackDashboard(
      [track("fresh"), track("stale", { lastTouchedAt: at(-20) })],
      [checkIn("fresh", 1, 20)],
      plan([]),
      WEEK_START,
      NOW,
    );
    expect(rows.map((r) => [r.trackId, r.daysSinceTouched, r.atRisk])).toEqual([
      ["fresh", 1, false],
      ["stale", 22, true],
    ]);
  });

  it("counts a streak of weeks with a check-in, without resetting it before this week ends", () => {
    // Checked in the last three weeks, not yet this week: the streak is still 3.
    const ins = [checkIn("a", -1, 20), checkIn("a", -8, 20), checkIn("a", -15, 20)];
    const before = trackDashboard([track("a")], ins, plan([]), WEEK_START, NOW);
    expect(before[0]?.streakWeeks).toBe(3);
    // A check-in this week makes it 4.
    const after = trackDashboard(
      [track("a")],
      [...ins, checkIn("a", 1, 20)],
      plan([]),
      WEEK_START,
      NOW,
    );
    expect(after[0]?.streakWeeks).toBe(4);
  });

  it("ends a streak at a fully missed past week", () => {
    // Last week had nothing; two weeks ago did.
    const rows = trackDashboard([track("a")], [checkIn("a", -10, 20)], plan([]), WEEK_START, NOW);
    expect(rows[0]?.streakWeeks).toBe(0);
  });

  it("gives the percent per week still needed to finish by the target date", () => {
    // 6 weeks left from now, 40% done: 10% a week.
    const target = new Date(NOW.getTime() + 42 * DAY);
    const rows = trackDashboard(
      [track("c", { type: "course", targetDate: target }), track("p")],
      [checkIn("c", 0, 30, 25), checkIn("c", 1, 30, 40), checkIn("p", 1, 30, 70)],
      plan([]),
      WEEK_START,
      NOW,
    );
    expect(rows.map((r) => [r.trackId, r.percent, r.percentPerWeekNeeded])).toEqual([
      ["c", 40, 10],
      ["p", 70, null],
    ]);
  });
});

describe("weeklyReview (GRW-007)", () => {
  const tracks = [track("a"), track("b"), track("c")];
  const week = plan(
    [
      ["a", [60, 60]],
      ["b", [60, 60]],
    ],
    [["c", [30]]],
  );

  it("lists what moved, with done against planned, and what wasn't reached", () => {
    const review = weeklyReview(
      tracks,
      week,
      [checkIn("a", 1, 90), checkIn("c", 2, 30)],
      WEEK_START,
    );
    expect(review.moved).toEqual([
      { trackId: "a", minutes: 90, plannedMinutes: 120 },
      { trackId: "c", minutes: 30, plannedMinutes: 30 },
    ]);
    expect(review.notReached).toEqual(["b"]);
    expect(review.log).toEqual([
      "Track A: 90 of 120 min",
      "Track C: 30 of 30 min",
      // Touched 2 days before the week, 7-day threshold: at risk when next week starts.
      "Track B: not reached this week; it goes first in next week's plan",
    ]);
  });

  it("promises nothing the planner won't do: a track not yet at risk next week just says not reached", () => {
    const patient = track("e", { lastTouchedAt: at(-2), untouchedDays: 14 });
    const review = weeklyReview([patient], plan([["e", [60, 60]]]), [], WEEK_START);
    expect(review.log).toEqual(["Track E: not reached this week"]);
  });

  it("never uses guilt words in its log (UX-032)", () => {
    const review = weeklyReview(tracks, week, [], WEEK_START);
    expect(review.log.join(" ")).not.toMatch(/miss|fail|broke|behind|lazy|slip/i);
  });
});

describe("weekStartOf", () => {
  it("gives the Monday, UTC, of the week a time falls in", () => {
    expect([
      weekStartOf(new Date("2026-11-26T12:00:00Z")),
      weekStartOf(new Date("2026-11-23T00:00:00Z")),
      weekStartOf(new Date("2026-11-29T23:59:00Z")),
    ]).toEqual(["2026-11-23", "2026-11-23", "2026-11-23"]);
  });
});
