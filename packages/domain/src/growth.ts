import { z } from "zod";
import { err, ok, type Result } from "./result.js";

// The weekly growth planner (NS-171, GRW-001…004): which tracks are in focus this week, which get
// only maintenance, and how the week's minutes split. Plain code, no model, no I/O: the same input
// always gives the same plan.

export const TRACK_TYPES = ["project", "course", "cert", "skill"] as const;
export type TrackType = (typeof TRACK_TYPES)[number];
export const TRACK_STATUSES = ["active", "paused", "backlogged", "done"] as const;
export type TrackStatus = (typeof TRACK_STATUSES)[number];

// GRW-002: a next action is sized to one sitting.
export const MAX_NEXT_ACTION_MINUTES = 90;

// A real date: an Invalid Date would break the plan order (NaN compares false both ways).
// Shared with growth-progress.ts.
export const ValidDate = z
  .date()
  .refine((d) => !Number.isNaN(d.getTime()), { message: "invalid date" });

const Track = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(TRACK_TYPES),
  status: z.enum(TRACK_STATUSES),
  // 1 (low) to 5 (high).
  priority: z.number().int().min(1).max(5),
  targetDate: ValidDate.nullable(),
  // Null when it has never been touched.
  lastTouchedAt: ValidDate.nullable(),
  // GRW-004's per-track N: untouched longer than this is "at risk".
  untouchedDays: z.number().int().min(1).max(365).default(7),
  // GRW-002: a next action of at least a minute; over 90 is flagged, not refused.
  nextAction: z.object({ title: z.string().min(1), minutes: z.number().int().min(1) }).nullable(),
});
export type GrowthTrack = z.infer<typeof Track>;

export type InvalidTrack = { kind: "InvalidTrack"; fields: string[] };

// Checks a track from storage or input; the error names the bad fields, never their values.
export function parseGrowthTrack(input: unknown): Result<GrowthTrack, InvalidTrack> {
  const parsed = Track.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  return err({
    kind: "InvalidTrack",
    fields: [...new Set(parsed.error.issues.map((i) => i.path.join(".")))],
  });
}

const Settings = z.object({
  // Q-09's default: 8 hours a week.
  weeklyMinutes: z.number().int().min(0).max(10_080).default(480),
  // GRW-004's default: 3 tracks in focus per week.
  wipLimit: z.number().int().min(1).max(10).default(3),
  // One focus session; never longer than a next action may be.
  blockMinutes: z.number().int().min(15).max(MAX_NEXT_ACTION_MINUTES).default(60),
  // One short block per maintenance track, so it doesn't go stale. At least 15 minutes, so a
  // track with no block is always one the hours ran out for (`no_time`).
  maintenanceMinutes: z.number().int().min(15).max(MAX_NEXT_ACTION_MINUTES).default(30),
  // GRW-004: each focus track gets at least this many sessions a week.
  minFocusSessions: z.number().int().min(1).max(7).default(2),
});
export type PlanSettings = z.infer<typeof Settings>;
export const DEFAULT_PLAN_SETTINGS: PlanSettings = Settings.parse({});

export type InvalidSettings = { kind: "InvalidSettings"; fields: string[] };

export function parsePlanSettings(input: unknown): Result<PlanSettings, InvalidSettings> {
  const parsed = Settings.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  return err({
    kind: "InvalidSettings",
    fields: [...new Set(parsed.error.issues.map((i) => i.path.join(".")))],
  });
}

export type PlannedTrack = { trackId: string; blocks: number[] };
export type PlanNote = { trackId: string; note: "over_capacity" | "no_time" };

export type WeekPlan = {
  focus: PlannedTrack[];
  maintenance: PlannedTrack[];
  // Active tracks untouched past their threshold, in plan order.
  atRisk: string[];
  // Active tracks whose next action is missing or too long, by id.
  needsNextAction: string[];
  // Why an active track got less than its place would give it.
  notes: PlanNote[];
  // Tracks that aren't active, with their status, by id.
  unplanned: { trackId: string; reason: Exclude<TrackStatus, "active"> }[];
};

export const DAY_MS = 86_400_000;

// GRW-004's rule, shared with the dashboard and the review so they can't drift apart. Callers
// apply it to active tracks only: pausing a track is how Paul says it isn't at risk.
export function isAtRisk(t: GrowthTrack, now: Date): boolean {
  if (t.lastTouchedAt === null) return true;
  return now.getTime() - t.lastTouchedAt.getTime() > t.untouchedDays * DAY_MS;
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Plan order: at risk first, then higher priority, then the nearer target date (none last), then
// id, so input order never matters.
function rank(tracks: GrowthTrack[], now: Date): GrowthTrack[] {
  const target = (t: GrowthTrack) => t.targetDate?.getTime() ?? Number.POSITIVE_INFINITY;
  return [...tracks].sort((a, b) => {
    const risk = Number(isAtRisk(b, now)) - Number(isAtRisk(a, now));
    if (risk !== 0) return risk;
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (target(a) !== target(b)) return target(a) - target(b);
    return byId(a, b);
  });
}

export function planWeek(tracks: GrowthTrack[], settings: PlanSettings, now: Date): WeekPlan {
  const active = rank(
    tracks.filter((t) => t.status === "active"),
    now,
  );
  const unplanned = tracks
    .filter((t) => t.status !== "active")
    .sort(byId)
    // The filter above leaves only non-active statuses; TypeScript's filter doesn't narrow that.
    .map((t) => ({ trackId: t.id, reason: t.status as Exclude<TrackStatus, "active"> }));
  const needsNextAction = active
    .filter((t) => t.nextAction === null || t.nextAction.minutes > MAX_NEXT_ACTION_MINUTES)
    .map((t) => t.id)
    .sort();
  const atRisk = active.filter((t) => isAtRisk(t, now)).map((t) => t.id);

  const { weeklyMinutes, blockMinutes, maintenanceMinutes, minFocusSessions } = settings;
  const minimumFocus = minFocusSessions * blockMinutes;
  // As many focus tracks as the WIP limit allows and the week can give their minimum sessions.
  const focusCount = Math.min(
    settings.wipLimit,
    active.length,
    Math.floor(weeklyMinutes / minimumFocus),
  );
  const focusTracks = active.slice(0, focusCount);
  // Tracks the WIP limit allowed in focus but the hours didn't.
  const squeezed = active.slice(focusCount, Math.min(settings.wipLimit, active.length));
  const maintenanceTracks = active.slice(focusCount);

  const squeezedIds = new Set(squeezed.map((t) => t.id));
  const notes: PlanNote[] = [];
  let left = weeklyMinutes - focusCount * minimumFocus;

  // Each maintenance track gets one short block while time is left, in plan order. One note per
  // track at most: no block at all says more than "moved out of focus".
  const maintenance: PlannedTrack[] = [];
  for (const t of maintenanceTracks) {
    if (left >= maintenanceMinutes) {
      maintenance.push({ trackId: t.id, blocks: [maintenanceMinutes] });
      left -= maintenanceMinutes;
      if (squeezedIds.has(t.id)) notes.push({ trackId: t.id, note: "over_capacity" });
    } else {
      notes.push({ trackId: t.id, note: "no_time" });
    }
  }

  // Focus tracks start at their minimum; leftover blocks go round-robin in plan order.
  const focus: PlannedTrack[] = focusTracks.map((t) => ({
    trackId: t.id,
    blocks: Array<number>(minFocusSessions).fill(blockMinutes),
  }));
  for (let i = 0; focus.length > 0 && left >= blockMinutes; i = (i + 1) % focus.length) {
    focus[i]?.blocks.push(blockMinutes);
    left -= blockMinutes;
  }

  return { focus, maintenance, atRisk, needsNextAction, notes, unplanned };
}
