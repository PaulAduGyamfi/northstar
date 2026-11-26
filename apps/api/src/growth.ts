import type {
  GrowthSettingsInput,
  GrowthTrackView,
  StoredCheckIn,
  StoredReview,
} from "@northstar/db";
import {
  type CheckIn,
  DAY_MS,
  DEFAULT_PLAN_SETTINGS,
  type GrowthTrack,
  planWeek,
  TRACK_STATUSES,
  TRACK_TYPES,
  trackDashboard,
  type WeekPlan,
  weeklyReview,
  weekStartOf,
} from "@northstar/domain";
import { z } from "zod";
import { type AnyEndpoint, endpoint } from "./endpoint.js";

// The Grow tab's endpoints (NS-214, GRW-005…007), all behind Paul's session. The figures come
// from packages/domain's trackDashboard and weeklyReview over what packages/db stores; bin.ts
// wires the reads and writes, tests fake them. Track names are Paul's own, shown only to him.

export type GrowthPorts = {
  now: () => Date;
  tracks: () => Promise<{ version: number; tracks: GrowthTrackView[] } | null>;
  settings: () => Promise<GrowthSettingsInput | null>;
  plan: (weekStart: string) => Promise<{ plan: Record<string, unknown> } | null>;
  checkIns: (since: Date) => Promise<StoredCheckIn[]>;
  review: (weekStart: string) => Promise<StoredReview | null>;
  recordCheckIn: (input: {
    key: string;
    minutes: number;
    percent: number | null;
    idempotencyKey: string;
  }) => Promise<
    { ok: true; status: "recorded" | "replayed" } | { ok: false; error: { kind: "UnknownTrack" } }
  >;
  saveReview: (input: {
    weekStart: string;
    moved: StoredReview["moved"];
    notReached: string[];
  }) => Promise<StoredReview>;
};

const WEEK_MS = 7 * DAY_MS;
// How far back check-ins are read: long enough for any streak Paul will see.
const STREAK_WEEKS = 52;

const Key = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

const Row = z.object({
  key: z.string(),
  name: z.string(),
  type: z.enum(TRACK_TYPES),
  status: z.enum(TRACK_STATUSES),
  minutesThisWeek: z.number(),
  plannedMinutes: z.number(),
  daysSinceTouched: z.number().nullable(),
  atRisk: z.boolean(),
  streakWeeks: z.number(),
  percent: z.number().nullable(),
  percentPerWeekNeeded: z.number().nullable(),
});

// A review as shown: each track with its current name, or null when it's no longer a track.
const Review = z.object({
  weekStart: z.string(),
  moved: z.array(
    z.object({
      key: z.string(),
      name: z.string().nullable(),
      minutes: z.number(),
      plannedMinutes: z.number(),
    }),
  ),
  notReached: z.array(z.object({ key: z.string(), name: z.string().nullable() })),
});

const View = z.object({
  weekStart: z.string(),
  // False: no plan stored for this week yet, so planned minutes come from a preview.
  planStored: z.boolean(),
  tracks: z.array(Row),
  lastWeek: z.object({ weekStart: z.string(), review: Review.nullable() }),
});

const CheckInBody = z.object({
  key: Key,
  minutes: z.number().int().min(1).max(600),
  percent: z.number().min(0).max(100).nullable(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_:-]{8,100}$/),
});

// packages/db's view of a track as the planner's GrowthTrack (keys are the planner's ids).
export function plannerTracks(tracks: GrowthTrackView[]): GrowthTrack[] {
  return tracks.map((t) => ({
    id: t.key,
    name: t.name,
    type: t.type,
    status: t.status,
    priority: t.priority,
    targetDate: t.target === null ? null : new Date(`${t.target}T00:00:00Z`),
    lastTouchedAt: t.lastTouchedAt,
    untouchedDays: t.untouchedDays,
    nextAction: t.next,
  }));
}

// A track Paul removed from his file after last week still had its plan and its logged time:
// without a stand-in, weeklyReview would drop that time and call the track "not reached". The
// stand-in carries only the key; the review shows it as no longer a track.
export function withStandIns(
  tracks: GrowthTrack[],
  plan: WeekPlan,
  checkIns: CheckIn[],
): GrowthTrack[] {
  const known = new Set(tracks.map((t) => t.id));
  const keys = [
    ...[...plan.focus, ...plan.maintenance].map((p) => p.trackId),
    ...checkIns.map((c) => c.trackId),
  ];
  const missing = [...new Set(keys)].filter((k) => !known.has(k));
  return [
    ...tracks,
    ...missing.map((key) => ({
      id: key,
      name: key,
      type: "project" as const,
      status: "done" as const,
      priority: 1,
      targetDate: null,
      lastTouchedAt: null,
      untouchedDays: 365,
      nextAction: null,
    })),
  ];
}

const asCheckIns = (stored: StoredCheckIn[]): CheckIn[] =>
  stored.map((c) => ({ trackId: c.key, at: c.at, minutes: c.minutes, percent: c.percent }));

const weekDate = (weekStart: string) => new Date(`${weekStart}T00:00:00Z`);

function showReview(review: StoredReview, names: Map<string, string>): z.infer<typeof Review> {
  return {
    weekStart: review.weekStart,
    moved: review.moved.map((m) => ({ ...m, name: names.get(m.key) ?? null })),
    notReached: review.notReached.map((key) => ({ key, name: names.get(key) ?? null })),
  };
}

// The whole Grow view for now: this week's figures and last week's stored review.
export async function growthView(ports: GrowthPorts): Promise<z.infer<typeof View>> {
  const now = ports.now();
  const weekStart = weekStartOf(now);
  const lastWeekStart = weekStartOf(new Date(weekDate(weekStart).getTime() - WEEK_MS));
  const current = await ports.tracks();
  const lastReview = await ports.review(lastWeekStart);
  const names = new Map((current?.tracks ?? []).map((t) => [t.key, t.name]));
  const lastWeek = {
    weekStart: lastWeekStart,
    review: lastReview === null ? null : showReview(lastReview, names),
  };
  if (current === null || current.tracks.length === 0) {
    return { weekStart, planStored: false, tracks: [], lastWeek };
  }
  const tracks = plannerTracks(current.tracks);
  const stored = await ports.plan(weekStart);
  // Without a stored plan the figures use a preview; nothing is stored from a read.
  const plan =
    stored === null
      ? planWeek(tracks, (await ports.settings()) ?? DEFAULT_PLAN_SETTINGS, now)
      : // Written only by saveWeekPlan from planWeek's own output, so its shape is planWeek's.
        (stored.plan as unknown as WeekPlan);
  const checkIns = asCheckIns(
    await ports.checkIns(new Date(weekDate(weekStart).getTime() - STREAK_WEEKS * WEEK_MS)),
  );
  const rows = trackDashboard(tracks, checkIns, plan, weekDate(weekStart), now);
  return {
    weekStart,
    planStored: stored !== null,
    tracks: current.tracks.map((t, i) => {
      const row = rows[i];
      if (row === undefined) throw new Error("trackDashboard returned fewer rows");
      return {
        key: t.key,
        name: t.name,
        type: t.type,
        status: t.status,
        minutesThisWeek: row.minutesThisWeek,
        plannedMinutes: row.plannedMinutes,
        daysSinceTouched: row.daysSinceTouched,
        atRisk: row.atRisk,
        streakWeeks: row.streakWeeks,
        percent: row.percent,
        percentPerWeekNeeded: row.percentPerWeekNeeded,
      };
    }),
    lastWeek,
  };
}

export function growthEndpoints(ports: GrowthPorts): AnyEndpoint[] {
  const view = endpoint({
    method: "GET",
    path: "/growth",
    auth: "session",
    input: z.object({}),
    output: View,
    handler: async () => {
      try {
        return { ok: true, body: await growthView(ports) };
      } catch {
        return { ok: false, status: 503, error: "unavailable" };
      }
    },
  });

  const checkIn = endpoint({
    method: "POST",
    path: "/growth/check-ins",
    auth: "session",
    input: CheckInBody,
    output: z.object({ status: z.enum(["recorded", "replayed"]) }),
    handler: async ({ key, minutes, percent, idempotencyKey }) => {
      try {
        // Fields picked by name; the time is the server's.
        const r = await ports.recordCheckIn({ key, minutes, percent, idempotencyKey });
        if (!r.ok) return { ok: false, status: 404, error: "unknown_track" };
        return { ok: true, body: { status: r.status } };
      } catch {
        return { ok: false, status: 503, error: "unavailable" };
      }
    },
  });

  const review = endpoint({
    method: "POST",
    path: "/growth/review",
    auth: "session",
    input: z.object({}),
    output: Review,
    handler: async () => {
      try {
        const now = ports.now();
        const lastWeekStart = weekStartOf(new Date(weekDate(weekStartOf(now)).getTime() - WEEK_MS));
        const stored = await ports.plan(lastWeekStart);
        const current = await ports.tracks();
        if (stored === null) return { ok: false, status: 409, error: "no_plan" };
        // Written only by saveWeekPlan from planWeek's own output, so its shape is planWeek's.
        const plan = stored.plan as unknown as WeekPlan;
        const checkIns = asCheckIns(await ports.checkIns(weekDate(lastWeekStart)));
        const tracks = withStandIns(plannerTracks(current?.tracks ?? []), plan, checkIns);
        const r = weeklyReview(tracks, plan, checkIns, weekDate(lastWeekStart));
        const saved = await ports.saveReview({
          weekStart: lastWeekStart,
          moved: r.moved.map((m) => ({
            key: m.trackId,
            minutes: m.minutes,
            plannedMinutes: m.plannedMinutes,
          })),
          notReached: r.notReached,
        });
        return {
          ok: true,
          body: showReview(saved, new Map((current?.tracks ?? []).map((t) => [t.key, t.name]))),
        };
      } catch {
        return { ok: false, status: 503, error: "unavailable" };
      }
    },
  });

  return [view, checkIn, review];
}
