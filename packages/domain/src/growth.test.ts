import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAN_SETTINGS,
  type GrowthTrack,
  type PlanSettings,
  parsePlanSettings,
  planWeek,
  type WeekPlan,
} from "./growth.js";

// The weekly growth planner (NS-171, GRW-001…004). Synthetic tracks only.
const NOW = new Date("2026-11-25T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const track = (id: string, over: Partial<GrowthTrack> = {}): GrowthTrack => ({
  id,
  name: `Track ${id}`,
  type: "project",
  status: "active",
  priority: 3,
  targetDate: null,
  lastTouchedAt: daysAgo(1),
  untouchedDays: 7,
  nextAction: { title: "Write the next test", minutes: 45 },
  ...over,
});

const settings = (over: Partial<PlanSettings> = {}): PlanSettings => ({
  ...DEFAULT_PLAN_SETTINGS,
  ...over,
});

const minutes = (plan: WeekPlan) =>
  [...plan.focus, ...plan.maintenance].reduce(
    (sum, p) => sum + p.blocks.reduce((s, b) => s + b, 0),
    0,
  );

describe("planWeek: focus and maintenance (GRW-003)", () => {
  it("with 10 h and 4 active tracks at WIP 3, plans 3 in focus with ≥ 2 blocks each and 1 in maintenance", () => {
    const plan = planWeek(
      [
        track("a", { priority: 5 }),
        track("b", { priority: 4 }),
        track("c", { priority: 3 }),
        track("d", { priority: 1 }),
      ],
      settings({ weeklyMinutes: 600, wipLimit: 3 }),
      NOW,
    );
    expect(plan.focus.map((f) => f.trackId)).toEqual(["a", "b", "c"]);
    expect(plan.maintenance.map((m) => m.trackId)).toEqual(["d"]);
    expect(plan.focus.every((f) => f.blocks.length >= 2)).toBe(true);
    expect(minutes(plan)).toBeLessThanOrEqual(600);
  });

  it("hands out leftover blocks round-robin in focus order, never past the week's minutes", () => {
    const plan = planWeek(
      [track("a", { priority: 5 }), track("b", { priority: 4 })],
      settings({ weeklyMinutes: 300, blockMinutes: 60, wipLimit: 3 }),
      NOW,
    );
    expect(plan.focus.map((f) => [f.trackId, f.blocks.length])).toEqual([
      ["a", 3],
      ["b", 2],
    ]);
    expect(minutes(plan)).toBe(300);
  });

  it("gives each maintenance track one short block", () => {
    const plan = planWeek(
      [track("a", { priority: 5 }), track("b", { priority: 1 })],
      settings({ weeklyMinutes: 480, wipLimit: 1, maintenanceMinutes: 30 }),
      NOW,
    );
    expect(plan.maintenance).toEqual([{ trackId: "b", blocks: [30] }]);
  });
});

describe("planWeek: balance rules (GRW-004)", () => {
  it("marks a track untouched past its threshold at risk and plans it before a higher-priority one", () => {
    const plan = planWeek(
      [
        track("busy", { priority: 5 }),
        track("stale", { priority: 1, lastTouchedAt: daysAgo(10), untouchedDays: 7 }),
      ],
      settings({ wipLimit: 1 }),
      NOW,
    );
    expect(plan.atRisk).toEqual(["stale"]);
    expect(plan.focus.map((f) => f.trackId)).toEqual(["stale"]);
    expect(plan.maintenance.map((m) => m.trackId)).toEqual(["busy"]);
  });

  it("treats a track never touched as at risk", () => {
    const plan = planWeek([track("new", { lastTouchedAt: null })], settings(), NOW);
    expect(plan.atRisk).toEqual(["new"]);
  });

  it("orders by the nearer target date when risk and priority tie", () => {
    const plan = planWeek(
      [
        track("later", { targetDate: new Date("2027-06-01T00:00:00Z") }),
        track("sooner", { targetDate: new Date("2026-12-15T00:00:00Z") }),
        track("none"),
      ],
      settings({ wipLimit: 3, weeklyMinutes: 600 }),
      NOW,
    );
    expect(plan.focus.map((f) => f.trackId)).toEqual(["sooner", "later", "none"]);
  });

  it("never plans a paused, backlogged or done track, and says why", () => {
    const plan = planWeek(
      [
        track("a"),
        track("p", { status: "paused", lastTouchedAt: daysAgo(30) }),
        track("b", { status: "backlogged" }),
        track("d", { status: "done" }),
      ],
      settings(),
      NOW,
    );
    expect([...plan.focus, ...plan.maintenance].map((x) => x.trackId)).toEqual(["a"]);
    expect(plan.unplanned).toEqual([
      { trackId: "b", reason: "backlogged" },
      { trackId: "d", reason: "done" },
      { trackId: "p", reason: "paused" },
    ]);
    // A paused track is never "at risk": pausing it is how Paul says so (GRW-004).
    expect(plan.atRisk).toEqual([]);
  });
});

describe("planWeek: over capacity", () => {
  it("shrinks focus to what fits and marks the moved tracks over_capacity", () => {
    // 150 min: 2 tracks × 2 blocks × 60 min would need 240.
    const plan = planWeek(
      [track("a", { priority: 5 }), track("b", { priority: 4 })],
      settings({ weeklyMinutes: 150, blockMinutes: 60, maintenanceMinutes: 30, wipLimit: 3 }),
      NOW,
    );
    expect(plan.focus.map((f) => [f.trackId, f.blocks.length])).toEqual([["a", 2]]);
    expect(plan.maintenance).toEqual([{ trackId: "b", blocks: [30] }]);
    expect(plan.notes).toEqual([{ trackId: "b", note: "over_capacity" }]);
    expect(minutes(plan)).toBeLessThanOrEqual(150);
  });

  it("leaves out maintenance blocks that don't fit, marked no_time", () => {
    const plan = planWeek(
      [track("a", { priority: 5 }), track("b", { priority: 1 }), track("c", { priority: 1 })],
      settings({ weeklyMinutes: 150, blockMinutes: 60, maintenanceMinutes: 30, wipLimit: 1 }),
      NOW,
    );
    expect(plan.maintenance).toEqual([{ trackId: "b", blocks: [30] }]);
    expect(plan.notes).toEqual([{ trackId: "c", note: "no_time" }]);
  });

  it("plans nothing with zero hours and says so for every active track", () => {
    const plan = planWeek([track("a")], settings({ weeklyMinutes: 0 }), NOW);
    expect([plan.focus, plan.maintenance]).toEqual([[], []]);
    expect(plan.notes).toEqual([{ trackId: "a", note: "no_time" }]);
  });
});

describe("planWeek: next actions (GRW-002)", () => {
  it("flags an active track whose next action is missing or longer than 90 minutes", () => {
    const plan = planWeek(
      [
        track("ok"),
        track("none", { nextAction: null }),
        track("long", { nextAction: { title: "Finish the whole course", minutes: 240 } }),
      ],
      settings({ weeklyMinutes: 600 }),
      NOW,
    );
    expect(plan.needsNextAction).toEqual(["long", "none"]);
  });
});

describe("planWeek: deterministic", () => {
  it("gives the same plan whatever order the tracks come in", () => {
    const tracks = [
      track("a", { priority: 2 }),
      track("b", { priority: 5 }),
      track("c", { priority: 2, lastTouchedAt: daysAgo(9) }),
      track("d", { priority: 4 }),
    ];
    const s = settings({ weeklyMinutes: 420 });
    expect(planWeek([...tracks].reverse(), s, NOW)).toEqual(planWeek(tracks, s, NOW));
  });

  it("never exceeds the week's minutes for any mix of tracks and settings", () => {
    for (let weekly = 0; weekly <= 900; weekly += 45) {
      for (let wip = 1; wip <= 4; wip++) {
        for (const block of [15, 30, 60, 90]) {
          const tracks = Array.from({ length: 6 }, (_, i) =>
            track(`t${i}`, { priority: (i % 5) + 1 }),
          );
          const plan = planWeek(
            tracks,
            settings({ weeklyMinutes: weekly, wipLimit: wip, blockMinutes: block }),
            NOW,
          );
          expect(minutes(plan)).toBeLessThanOrEqual(weekly);
        }
      }
    }
  });
});

describe("parsePlanSettings", () => {
  it("fills in Q-09's defaults: 8 hours a week, WIP 3", () => {
    expect(parsePlanSettings({})).toEqual({ ok: true, value: DEFAULT_PLAN_SETTINGS });
    expect([DEFAULT_PLAN_SETTINGS.weeklyMinutes, DEFAULT_PLAN_SETTINGS.wipLimit]).toEqual([480, 3]);
  });

  it("refuses settings out of range and names the fields", () => {
    expect(parsePlanSettings({ weeklyMinutes: -1, blockMinutes: 120, wipLimit: 0 })).toEqual({
      ok: false,
      error: { kind: "InvalidSettings", fields: ["weeklyMinutes", "wipLimit", "blockMinutes"] },
    });
  });
});
