import type { GrowthSettingsInput, GrowthTrackView, StoredPlan } from "@northstar/db";
import { describe, expect, it } from "vitest";
import { GROWTH_USAGE, type GrowthCliDeps, growthCommand, weekStartOf } from "./growth-cli.js";

// `profile growth …` (NS-210) with every dependency faked. Invented tracks only.

const NOW = new Date("2026-11-26T12:00:00Z"); // a Thursday

const TRACKS: GrowthTrackView[] = [
  {
    key: "cloud-cert",
    name: "Cloud certification",
    type: "cert",
    status: "active",
    priority: 4,
    target: null,
    untouchedDays: 7,
    next: { title: "Practice exam 1", minutes: 60 },
    lastTouchedAt: new Date("2026-11-25T09:00:00Z"),
  },
  {
    key: "side-app",
    name: "Budget app",
    type: "project",
    status: "paused",
    priority: 5,
    target: null,
    untouchedDays: 7,
    next: null,
    lastTouchedAt: null,
  },
];

function deps(over: Partial<GrowthCliDeps> = {}) {
  const printed: string[] = [];
  const plans: unknown[] = [];
  const settings: GrowthSettingsInput[] = [];
  const d: GrowthCliDeps = {
    print: (line) => printed.push(line),
    readText: async () => "cloud-cert | Cloud certification | cert | active | 4",
    now: () => NOW,
    setGrowthTracks: async (tracks) => ({ status: "set", version: 1, tracks: tracks.length }),
    readGrowthTracks: async () => ({ version: 3, tracks: TRACKS }),
    recordGrowthTouch: async (key) =>
      key === "cloud-cert" ? { ok: true } : { ok: false, error: { kind: "UnknownTrack" } },
    readGrowthSettings: async () => null,
    setGrowthSettings: async (s) => {
      settings.push(s);
    },
    saveWeekPlan: async (input): Promise<StoredPlan> => {
      plans.push(input);
      return {
        weekStart: input.weekStart,
        trackSetVersion: input.trackSetVersion,
        plan: input.plan,
        status: "planned",
      };
    },
    ...over,
  };
  return { d, printed, plans, settings };
}

describe("weekStartOf", () => {
  it("is the Monday of the week, in UTC", () => {
    expect([
      weekStartOf(NOW),
      weekStartOf(new Date("2026-11-23T00:00:00Z")),
      weekStartOf(new Date("2026-11-29T23:59:00Z")),
    ]).toEqual(["2026-11-23", "2026-11-23", "2026-11-23"]);
  });
});

describe("profile growth plan", () => {
  it("plans the week from the current tracks, leaving a paused track out of focus and maintenance", async () => {
    const { d, printed, plans } = deps();
    expect(await growthCommand(d, ["plan"])).toBe(0);
    const stored = plans[0] as {
      weekStart: string;
      trackSetVersion: number;
      plan: { focus: { trackId: string }[]; maintenance: { trackId: string }[] };
    };
    expect([
      stored.weekStart,
      stored.trackSetVersion,
      stored.plan.focus.map((f) => f.trackId),
      stored.plan.maintenance.map((m) => m.trackId),
      printed[0],
      printed.at(-1),
    ]).toEqual([
      "2026-11-23",
      3,
      ["cloud-cert"],
      [],
      "Plan for the week of 2026-11-23:",
      "Not planned: side-app (Budget app): paused",
    ]);
  });

  it("puts a track untouched past its threshold at risk, and a fresh touch takes it off", async () => {
    const withTouch = (at: string) => async () => ({
      version: 3,
      tracks: TRACKS.map((t) =>
        t.key === "cloud-cert" ? { ...t, lastTouchedAt: new Date(at) } : t,
      ),
    });
    const stale = deps({ readGrowthTracks: withTouch("2026-11-01T09:00:00Z") });
    const fresh = deps({ readGrowthTracks: withTouch("2026-11-25T09:00:00Z") });
    await growthCommand(stale.d, ["plan"]);
    await growthCommand(fresh.d, ["plan"]);
    const atRisk = (p: unknown[]) => (p[0] as { plan: { atRisk: string[] } }).plan.atRisk;
    expect([atRisk(stale.plans), atRisk(fresh.plans)]).toEqual([["cloud-cert"], []]);
  });

  it("shows the stored plan when the week is already planned", async () => {
    const { d, printed } = deps({
      saveWeekPlan: async (input) => ({
        weekStart: input.weekStart,
        trackSetVersion: 1,
        plan: {
          focus: [],
          maintenance: [],
          atRisk: [],
          needsNextAction: [],
          notes: [],
          unplanned: [],
        },
        status: "existing",
      }),
    });
    await growthCommand(d, ["plan"]);
    expect(printed.slice(0, 2)).toEqual([
      "Plan for the week of 2026-11-23 (already made; it stays as it was):",
      "Focus:",
    ]);
  });

  it("says how to start when there are no tracks", async () => {
    const { d, printed, plans } = deps({ readGrowthTracks: async () => null });
    await growthCommand(d, ["plan"]);
    expect([printed, plans.length]).toEqual([
      ["No growth tracks yet. Run: profile growth tracks set data/<file>"],
      0,
    ]);
  });
});

describe("profile growth tracks and touch", () => {
  it("stores a good file and prints counts only", async () => {
    const { d, printed } = deps();
    expect([await growthCommand(d, ["tracks", "set", "data/tracks.txt"]), printed]).toEqual([
      0,
      ["tracks.txt: stored version 1 (1 track)."],
    ]);
  });

  it("stores nothing for a bad file and names the line", async () => {
    let stores = 0;
    const { d, printed } = deps({
      readText: async () => "Bad Key | X | cert | active | 3",
      setGrowthTracks: async () => {
        stores++;
        return { status: "set", version: 1, tracks: 0 };
      },
    });
    expect([await growthCommand(d, ["tracks", "set", "data/t.txt"]), stores, printed[1]]).toEqual([
      1,
      0,
      "  line 1: the key must be 1–40 lowercase letters, digits or dashes",
    ]);
  });

  it("lists each track with its last touch", async () => {
    const { d, printed } = deps();
    await growthCommand(d, ["tracks"]);
    expect(printed).toEqual([
      "cloud-cert: Cloud certification (cert, active, priority 4) · last touched 2026-11-25",
      "side-app: Budget app (project, paused, priority 5) · last touched never",
    ]);
  });

  it("lists a track's goal, definition of done and milestones under it", async () => {
    const detailed: GrowthTrackView = {
      ...(TRACKS[0] as GrowthTrackView),
      goal: "Pass the associate exam",
      doneWhen: "Certificate issued",
      milestones: [
        { title: "Sections 1-12", doneOn: "2026-11-20" },
        { title: "Exam booked", doneOn: null },
      ],
    };
    const { d, printed } = deps({
      readGrowthTracks: async () => ({ version: 4, tracks: [detailed] }),
    });
    await growthCommand(d, ["tracks"]);
    expect(printed).toEqual([
      "cloud-cert: Cloud certification (cert, active, priority 4) · last touched 2026-11-25",
      "  goal: Pass the associate exam",
      "  done when: Certificate issued",
      "  [x] Sections 1-12 (done 2026-11-20)",
      "  [ ] Exam booked",
    ]);
  });

  it("records a touch, and refuses an unknown key", async () => {
    const { d, printed } = deps();
    expect([
      await growthCommand(d, ["touch", "cloud-cert"]),
      await growthCommand(d, ["touch", "nope"]),
    ]).toEqual([0, 1]);
    expect(printed).toEqual([
      "Noted: you worked on cloud-cert.",
      "No current track has the key nope. See profile growth tracks.",
    ]);
  });
});

describe("profile growth settings", () => {
  it("shows the defaults, saves a change, and refuses one out of range", async () => {
    const { d, printed, settings } = deps();
    await growthCommand(d, ["settings"]);
    const set = await growthCommand(d, ["settings", "set", "weeklyMinutes", "600"]);
    const bad = await growthCommand(d, ["settings", "set", "wipLimit", "0"]);
    const unknown = await growthCommand(d, ["settings", "set", "energy", "1"]);
    expect([printed[0], set, settings.map((s) => s.weeklyMinutes), bad, unknown]).toEqual([
      "weeklyMinutes: 480",
      0,
      [600],
      1,
      1,
    ]);
  });

  it("prints its usage for anything else", async () => {
    const { d, printed } = deps();
    expect([await growthCommand(d, ["grow"]), printed]).toEqual([1, [GROWTH_USAGE]]);
  });
});
