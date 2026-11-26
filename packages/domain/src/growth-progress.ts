import { z } from "zod";
import { DAY_MS, type GrowthTrack, isAtRisk, ValidDate, type WeekPlan } from "./growth.js";
import { err, ok, type Result } from "./result.js";

// Growth check-ins, dashboard figures and the weekly review (NS-172, GRW-005…007). Plain code, no
// I/O. Framing follows UX-032: progress is counted, never shamed.

const WEEK_MS = 7 * DAY_MS;

// GRW-005's 10-second manual check-in. No free-text field: nothing of Paul's words is kept here.
const CheckInSchema = z.object({
  trackId: z.string().min(1),
  at: ValidDate,
  minutes: z.number().int().min(1).max(600),
  // A course's completion, when Paul knows it.
  percent: z.number().min(0).max(100).nullable(),
});
export type CheckIn = z.infer<typeof CheckInSchema>;

export type InvalidCheckIn = { kind: "InvalidCheckIn"; fields: string[] };

export function parseCheckIn(input: unknown): Result<CheckIn, InvalidCheckIn> {
  const parsed = CheckInSchema.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  return err({
    kind: "InvalidCheckIn",
    fields: [...new Set(parsed.error.issues.map((i) => i.path.join(".")))],
  });
}

const newest = (dates: Date[]): Date | null =>
  dates.length === 0 ? null : new Date(Math.max(...dates.map((d) => d.getTime())));

const ofTrack = (checkIns: CheckIn[], trackId: string) =>
  checkIns.filter((c) => c.trackId === trackId);

// Each track's lastTouchedAt moved to its newest check-in, never earlier than it was. Feeding the
// result to planWeek is how a week's check-ins shape the next plan.
export function applyCheckIns(tracks: GrowthTrack[], checkIns: CheckIn[]): GrowthTrack[] {
  return tracks.map((t) => {
    const touched = newest([
      ...(t.lastTouchedAt ? [t.lastTouchedAt] : []),
      ...ofTrack(checkIns, t.id).map((c) => c.at),
    ]);
    return { ...t, lastTouchedAt: touched };
  });
}

const inWeek = (d: Date, weekStart: Date) =>
  d.getTime() >= weekStart.getTime() && d.getTime() < weekStart.getTime() + WEEK_MS;

const minutesIn = (checkIns: CheckIn[], weekStart: Date) =>
  checkIns.filter((c) => inWeek(c.at, weekStart)).reduce((sum, c) => sum + c.minutes, 0);

// The minutes a plan gives one track, focus or maintenance.
function plannedFor(plan: WeekPlan, trackId: string): number {
  const entry = [...plan.focus, ...plan.maintenance].find((p) => p.trackId === trackId);
  return entry ? entry.blocks.reduce((sum, b) => sum + b, 0) : 0;
}

// Weeks in a row with at least one check-in. The current week counts once it has one; until then
// the run continues from last week, so a streak never resets mid-week (UX-032).
function streakWeeks(checkIns: CheckIn[], weekStart: Date): number {
  const touchedWeek = (offset: number) => {
    const start = new Date(weekStart.getTime() - offset * WEEK_MS);
    return checkIns.some((c) => inWeek(c.at, start));
  };
  let weeks = touchedWeek(0) ? 1 : 0;
  for (let offset = 1; touchedWeek(offset); offset++) weeks++;
  return weeks;
}

export type DashboardRow = {
  trackId: string;
  minutesThisWeek: number;
  plannedMinutes: number;
  // Whole days since last touched, or null when never touched.
  daysSinceTouched: number | null;
  atRisk: boolean;
  streakWeeks: number;
  // The newest check-in's percent, if any.
  percent: number | null;
  // With a target date and a percent: what's still needed per week to finish by it.
  percentPerWeekNeeded: number | null;
};

// GRW-006's figures, one row per track in the order given.
export function trackDashboard(
  tracks: GrowthTrack[],
  checkIns: CheckIn[],
  plan: WeekPlan,
  weekStart: Date,
  now: Date,
): DashboardRow[] {
  return applyCheckIns(tracks, checkIns).map((t) => {
    const mine = ofTrack(checkIns, t.id);
    const touched = t.lastTouchedAt;
    // Never negative: a check-in dated after now counts as touched today.
    const daysSinceTouched =
      touched === null
        ? null
        : Math.max(0, Math.floor((now.getTime() - touched.getTime()) / DAY_MS));
    // The planner's own rule (GRW-004), for active tracks only: a paused or finished track is
    // never at risk (UX-032).
    const atRisk = t.status === "active" && isAtRisk(t, now);
    const withPercent = mine.filter((c) => c.percent !== null);
    const latest = withPercent.reduce<CheckIn | null>(
      (best, c) => (best === null || c.at > best.at ? c : best),
      null,
    );
    const percent = latest?.percent ?? null;
    // Once the target date has passed there's no weekly pace to give: null, as with no target.
    const weeksLeft = t.targetDate ? (t.targetDate.getTime() - now.getTime()) / WEEK_MS : null;
    const percentPerWeekNeeded =
      percent === null || weeksLeft === null || weeksLeft <= 0
        ? null
        : Math.round(((100 - percent) / weeksLeft) * 10) / 10;
    return {
      trackId: t.id,
      minutesThisWeek: minutesIn(mine, weekStart),
      plannedMinutes: plannedFor(plan, t.id),
      daysSinceTouched,
      atRisk,
      streakWeeks: streakWeeks(mine, weekStart),
      percent,
      percentPerWeekNeeded,
    };
  });
}

export type WeeklyReview = {
  moved: { trackId: string; minutes: number; plannedMinutes: number }[];
  // Planned tracks with no check-in this week.
  notReached: string[];
  // Plain, neutral lines for the review (UX-032: no guilt words).
  log: string[];
};

// GRW-007's review of one week: what moved, what wasn't reached, and a short log.
export function weeklyReview(
  tracks: GrowthTrack[],
  plan: WeekPlan,
  checkIns: CheckIn[],
  weekStart: Date,
): WeeklyReview {
  const name = new Map(tracks.map((t) => [t.id, t.name]));
  const planned = [...plan.focus, ...plan.maintenance].map((p) => p.trackId);
  const moved = tracks
    .map((t) => ({
      trackId: t.id,
      minutes: minutesIn(ofTrack(checkIns, t.id), weekStart),
      plannedMinutes: plannedFor(plan, t.id),
    }))
    .filter((m) => m.minutes > 0);
  const movedIds = new Set(moved.map((m) => m.trackId));
  // The tracks as next week's plan will see them: this week's check-ins applied.
  const touchedById = new Map(applyCheckIns(tracks, checkIns).map((t) => [t.id, t]));
  const nextWeekStart = new Date(weekStart.getTime() + WEEK_MS);
  const notReached = planned.filter((id) => !movedIds.has(id));
  const log = [
    ...moved.map(
      (m) => `${name.get(m.trackId) ?? m.trackId}: ${m.minutes} of ${m.plannedMinutes} min`,
    ),
    ...notReached.map((id) => {
      const t = touchedById.get(id);
      // Only say what the planner will do: at risk when next week starts puts it first.
      const first = t !== undefined && t.status === "active" && isAtRisk(t, nextWeekStart);
      return `${name.get(id) ?? id}: not reached this week${first ? "; it goes first in next week's plan" : ""}`;
    }),
  ];
  return { moved, notReached, log };
}
