import { createHash } from "node:crypto";
import type { CandidateId } from "@northstar/domain";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import {
  growthCheckIn,
  growthMilestone,
  growthPlan,
  growthReview,
  growthSettings,
  growthTouch,
  growthTrack,
  growthTrackSet,
} from "./growth-schema.js";
import { appendEvent, inSpan } from "./resilience-event.js";

// The growth tracker's only write path (NS-210, GRW-001…004). Tracks come from Paul's file
// (parsed in packages/profile), touches and settings from his commands, and each week's plan from
// planWeek (packages/domain). Events carry versions, counts and row ids only: never a track key,
// name or next action, which are Paul's words.

export type GrowthTrackInput = {
  key: string;
  name: string;
  type: "project" | "course" | "cert" | "skill";
  status: "active" | "paused" | "backlogged" | "done";
  priority: number;
  // YYYY-MM-DD, or null.
  target: string | null;
  untouchedDays: number;
  next: { title: string; minutes: number } | null;
  // GRW-001/002 (NS-232); each only when Paul's file gives it.
  goal?: string;
  doneWhen?: string;
  milestones?: { title: string; doneOn: string | null }[];
};

export type GrowthTrackView = GrowthTrackInput & { lastTouchedAt: Date | null };

export type GrowthSettingsInput = {
  weeklyMinutes: number;
  wipLimit: number;
  blockMinutes: number;
  maintenanceMinutes: number;
  minFocusSessions: number;
};

const sha256 = (tracks: readonly GrowthTrackInput[]) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        tracks.map((t) => [
          t.key,
          t.name,
          t.type,
          t.status,
          t.priority,
          t.target,
          t.untouchedDays,
          t.next?.title ?? null,
          t.next?.minutes ?? null,
          // Only when given: a file without them hashes as it did before NS-232, so it isn't
          // stored again as a new version.
          ...(t.goal !== undefined || t.doneWhen !== undefined || t.milestones?.length
            ? [
                t.goal ?? null,
                t.doneWhen ?? null,
                (t.milestones ?? []).map((m) => [m.title, m.doneOn]),
              ]
            : []),
        ]),
      ),
    )
    .digest("hex");

// A fresh error with no cause: the driver's message lists the query's parameters, which are
// Paul's track names and next actions.
async function guarded<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    throw new Error(`${name} failed`);
  }
}

// Stores Paul's tracks file as the next version; the same tracks as the newest store nothing.
export async function setGrowthTracks(
  db: Db,
  input: { candidateId: CandidateId; tracks: readonly GrowthTrackInput[] },
): Promise<{ status: "set" | "unchanged"; version: number; tracks: number }> {
  const sha = sha256(input.tracks);
  return guarded("growth.tracks_set", () =>
    inSpan("growth.tracks_set", { "northstar.growth.tracks": input.tracks.length }, (span) =>
      db.transaction(async (tx) => {
        const [latest] = await tx
          .select({ version: growthTrackSet.version, sha: growthTrackSet.contentSha256 })
          .from(growthTrackSet)
          .where(eq(growthTrackSet.candidateId, input.candidateId))
          .orderBy(desc(growthTrackSet.version))
          .limit(1);
        if (latest && latest.sha === sha) {
          return {
            status: "unchanged" as const,
            version: latest.version,
            tracks: input.tracks.length,
          };
        }
        const version = (latest?.version ?? 0) + 1;
        const [set] = await tx
          .insert(growthTrackSet)
          .values({ candidateId: input.candidateId, version, contentSha256: sha })
          .returning({ id: growthTrackSet.id, createdAt: growthTrackSet.createdAt });
        if (!set) throw new Error("growth_track_set insert returned no row");
        if (input.tracks.length > 0) {
          const rows = await tx
            .insert(growthTrack)
            .values(
              input.tracks.map((t, position) => ({
                candidateId: input.candidateId,
                setId: set.id,
                position,
                key: t.key,
                name: t.name,
                type: t.type,
                status: t.status,
                priority: t.priority,
                targetDate: t.target,
                untouchedDays: t.untouchedDays,
                nextTitle: t.next?.title ?? null,
                nextMinutes: t.next?.minutes ?? null,
                goal: t.goal ?? null,
                doneWhen: t.doneWhen ?? null,
              })),
            )
            .returning({ id: growthTrack.id, position: growthTrack.position });
          const idAt = new Map(rows.map((r) => [r.position, r.id]));
          const milestones = input.tracks.flatMap((t, position) =>
            (t.milestones ?? []).map((m, i) => ({
              candidateId: input.candidateId,
              trackId: idAt.get(position) ?? "",
              position: i,
              title: m.title,
              doneOn: m.doneOn,
            })),
          );
          if (milestones.length > 0) await tx.insert(growthMilestone).values(milestones);
        }
        const active = input.tracks.filter((t) => t.status === "active").length;
        await appendEvent(tx, span, {
          candidateId: input.candidateId,
          aggregate: `growth_track_set:${set.id}`,
          type: "growth.tracks_set",
          actor: "user",
          reason: "Paul updated his growth tracks",
          payload: { setId: set.id, version, tracks: input.tracks.length, active },
          idempotencyKey: `growth-tracks-set:${set.id}`,
          at: set.createdAt,
        });
        return { status: "set" as const, version, tracks: input.tracks.length };
      }),
    ),
  );
}

// The current tracks, in file order, each with its newest touch; null before the first file.
export async function readGrowthTracks(
  db: Db,
  candidateId: CandidateId,
): Promise<{ version: number; tracks: GrowthTrackView[] } | null> {
  // Guarded too: a failed read's driver message would list the track keys it asked for.
  return guarded("growth.read", () => readTracks(db, candidateId));
}

async function readTracks(
  db: Db,
  candidateId: CandidateId,
): Promise<{ version: number; tracks: GrowthTrackView[] } | null> {
  const [set] = await db
    .select({ id: growthTrackSet.id, version: growthTrackSet.version })
    .from(growthTrackSet)
    .where(eq(growthTrackSet.candidateId, candidateId))
    .orderBy(desc(growthTrackSet.version))
    .limit(1);
  if (!set) return null;
  const rows = await db
    .select()
    .from(growthTrack)
    .where(and(eq(growthTrack.candidateId, candidateId), eq(growthTrack.setId, set.id)))
    .orderBy(asc(growthTrack.position));
  const keys = rows.map((r) => r.key);
  // Milestones of these track rows, in order (NS-232).
  const ids = rows.map((r) => r.id);
  const milestoneRows =
    ids.length === 0
      ? []
      : await db
          .select({
            trackId: growthMilestone.trackId,
            title: growthMilestone.title,
            doneOn: growthMilestone.doneOn,
          })
          .from(growthMilestone)
          .where(
            and(
              eq(growthMilestone.candidateId, candidateId),
              inArray(growthMilestone.trackId, ids),
            ),
          )
          .orderBy(asc(growthMilestone.trackId), asc(growthMilestone.position));
  const milestonesOf = new Map<string, { title: string; doneOn: string | null }[]>();
  for (const m of milestoneRows) {
    milestonesOf.set(m.trackId, [
      ...(milestonesOf.get(m.trackId) ?? []),
      { title: m.title, doneOn: m.doneOn },
    ]);
  }
  const touches =
    keys.length === 0
      ? []
      : await db
          .select({ key: growthTouch.trackKey, at: sql<Date>`max(${growthTouch.touchedAt})` })
          .from(growthTouch)
          .where(and(eq(growthTouch.candidateId, candidateId), inArray(growthTouch.trackKey, keys)))
          .groupBy(growthTouch.trackKey);
  // A check-in is a touch too (NS-214, GRW-005): the planner sees it.
  const checkIns =
    keys.length === 0
      ? []
      : await db
          .select({
            key: growthCheckIn.trackKey,
            at: sql<Date>`max(${growthCheckIn.checkedInAt})`,
          })
          .from(growthCheckIn)
          .where(
            and(eq(growthCheckIn.candidateId, candidateId), inArray(growthCheckIn.trackKey, keys)),
          )
          .groupBy(growthCheckIn.trackKey);
  const last = new Map<string, Date>();
  for (const t of [...touches, ...checkIns]) {
    const at = new Date(t.at);
    const seen = last.get(t.key);
    if (seen === undefined || at > seen) last.set(t.key, at);
  }
  return {
    version: set.version,
    tracks: rows.map((r) => ({
      key: r.key,
      name: r.name,
      type: r.type as GrowthTrackInput["type"],
      status: r.status as GrowthTrackInput["status"],
      priority: r.priority,
      target: r.targetDate,
      untouchedDays: r.untouchedDays,
      next:
        r.nextTitle !== null && r.nextMinutes !== null
          ? { title: r.nextTitle, minutes: r.nextMinutes }
          : null,
      lastTouchedAt: last.get(r.key) ?? null,
      // Only when stored, as the file gave them (NS-232).
      ...(r.goal !== null ? { goal: r.goal } : {}),
      ...(r.doneWhen !== null ? { doneWhen: r.doneWhen } : {}),
      ...(milestonesOf.has(r.id) ? { milestones: milestonesOf.get(r.id) } : {}),
    })),
  };
}

// Records that Paul worked on a current track. An unknown key stores nothing.
export async function recordGrowthTouch(
  db: Db,
  input: { candidateId: CandidateId; key: string; at?: Date },
): Promise<{ ok: true } | { ok: false; error: { kind: "UnknownTrack" } }> {
  const current = await readGrowthTracks(db, input.candidateId);
  if (!current?.tracks.some((t) => t.key === input.key)) {
    return { ok: false, error: { kind: "UnknownTrack" } };
  }
  return guarded("growth.touched", () =>
    inSpan("growth.touched", {}, (span) =>
      db.transaction(async (tx) => {
        const [touch] = await tx
          .insert(growthTouch)
          .values({
            candidateId: input.candidateId,
            trackKey: input.key,
            ...(input.at ? { touchedAt: input.at } : {}),
          })
          .returning({ id: growthTouch.id, at: growthTouch.touchedAt });
        if (!touch) throw new Error("growth_touch insert returned no row");
        await appendEvent(tx, span, {
          candidateId: input.candidateId,
          aggregate: `growth_touch:${touch.id}`,
          type: "growth.touched",
          actor: "user",
          reason: "Paul worked on a growth track",
          // The row id only: the key is Paul's word for the track.
          payload: { touchId: touch.id },
          idempotencyKey: `growth-touch:${touch.id}`,
          at: touch.at,
        });
        return { ok: true as const };
      }),
    ),
  );
}

// Stores new planner settings; the newest row is current.
export async function setGrowthSettings(
  db: Db,
  input: { candidateId: CandidateId; settings: GrowthSettingsInput },
): Promise<void> {
  await guarded("growth.settings_set", () =>
    db.insert(growthSettings).values({ candidateId: input.candidateId, ...input.settings }),
  );
}

// The current planner settings, or null when Paul never set any (the defaults apply).
export async function readGrowthSettings(
  db: Db,
  candidateId: CandidateId,
): Promise<GrowthSettingsInput | null> {
  const [row] = await db
    .select()
    .from(growthSettings)
    .where(eq(growthSettings.candidateId, candidateId))
    .orderBy(desc(growthSettings.createdAt), desc(growthSettings.id))
    .limit(1);
  if (!row) return null;
  return {
    weeklyMinutes: row.weeklyMinutes,
    wipLimit: row.wipLimit,
    blockMinutes: row.blockMinutes,
    maintenanceMinutes: row.maintenanceMinutes,
    minFocusSessions: row.minFocusSessions,
  };
}

export type StoredPlan = {
  weekStart: string;
  trackSetVersion: number;
  plan: Record<string, unknown>;
  status: "planned" | "existing";
};

// Stores one week's plan once. A week already planned keeps its plan: the first is returned, and
// nothing is stored (safe to repeat).
export async function saveWeekPlan(
  db: Db,
  input: {
    candidateId: CandidateId;
    weekStart: string;
    trackSetVersion: number;
    plan: Record<string, unknown>;
    counts: { focus: number; maintenance: number; atRisk: number };
  },
): Promise<StoredPlan> {
  return guarded("growth.planned", () =>
    inSpan("growth.planned", { "northstar.growth.focus": input.counts.focus }, (span) =>
      db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(growthPlan)
          .where(
            and(
              eq(growthPlan.candidateId, input.candidateId),
              eq(growthPlan.weekStart, input.weekStart),
            ),
          );
        if (existing) {
          return {
            weekStart: existing.weekStart,
            trackSetVersion: existing.trackSetVersion,
            plan: existing.plan,
            status: "existing" as const,
          };
        }
        const [row] = await tx
          .insert(growthPlan)
          .values({
            candidateId: input.candidateId,
            weekStart: input.weekStart,
            trackSetVersion: input.trackSetVersion,
            plan: input.plan,
          })
          // Another run planned this week meanwhile: theirs stands, and is returned below.
          .onConflictDoNothing({ target: [growthPlan.candidateId, growthPlan.weekStart] })
          .returning({ id: growthPlan.id, createdAt: growthPlan.createdAt });
        if (!row) {
          const [theirs] = await tx
            .select()
            .from(growthPlan)
            .where(
              and(
                eq(growthPlan.candidateId, input.candidateId),
                eq(growthPlan.weekStart, input.weekStart),
              ),
            );
          if (!theirs) throw new Error("growth_plan insert returned no row");
          return {
            weekStart: theirs.weekStart,
            trackSetVersion: theirs.trackSetVersion,
            plan: theirs.plan,
            status: "existing" as const,
          };
        }
        await appendEvent(tx, span, {
          candidateId: input.candidateId,
          aggregate: `growth_plan:${row.id}`,
          type: "growth.planned",
          actor: "system",
          reason: "Planned this week's growth time",
          payload: { planId: row.id, weekStart: input.weekStart, ...input.counts },
          idempotencyKey: `growth-planned:${input.weekStart}`,
          at: row.createdAt,
        });
        return {
          weekStart: input.weekStart,
          trackSetVersion: input.trackSetVersion,
          plan: input.plan,
          status: "planned" as const,
        };
      }),
    ),
  );
}

// The plan stored for a week (YYYY-MM-DD, a Monday), or null.
export async function readWeekPlan(
  db: Db,
  candidateId: CandidateId,
  weekStart: string,
): Promise<{ trackSetVersion: number; plan: Record<string, unknown> } | null> {
  const [row] = await guarded("growth.read", () =>
    db
      .select({ trackSetVersion: growthPlan.trackSetVersion, plan: growthPlan.plan })
      .from(growthPlan)
      .where(and(eq(growthPlan.candidateId, candidateId), eq(growthPlan.weekStart, weekStart))),
  );
  return row ?? null;
}

export type CheckInInput = {
  candidateId: CandidateId;
  key: string;
  minutes: number;
  percent: number | null;
  // From the client, one per form: a double submit stores one check-in.
  idempotencyKey: string;
  at?: Date;
};

export type StoredCheckIn = { key: string; at: Date; minutes: number; percent: number | null };

// Stores one check-in (NS-214, GRW-005) on a current track. A repeated idempotency key stores
// nothing and says so; an unknown track key stores nothing.
export async function recordCheckIn(
  db: Db,
  input: CheckInInput,
): Promise<
  { ok: true; status: "recorded" | "replayed" } | { ok: false; error: { kind: "UnknownTrack" } }
> {
  const current = await readGrowthTracks(db, input.candidateId);
  if (!current?.tracks.some((t) => t.key === input.key)) {
    return { ok: false, error: { kind: "UnknownTrack" } };
  }
  return guarded("growth.check_in", () =>
    inSpan("growth.check_in", { "northstar.growth.minutes": input.minutes }, (span) =>
      db.transaction(async (tx) => {
        const [row] = await tx
          .insert(growthCheckIn)
          .values({
            candidateId: input.candidateId,
            trackKey: input.key,
            minutes: input.minutes,
            percent: input.percent,
            idempotencyKey: input.idempotencyKey,
            ...(input.at ? { checkedInAt: input.at } : {}),
          })
          .onConflictDoNothing({
            target: [growthCheckIn.candidateId, growthCheckIn.idempotencyKey],
          })
          .returning({ id: growthCheckIn.id, at: growthCheckIn.checkedInAt });
        if (!row) return { ok: true as const, status: "replayed" as const };
        await appendEvent(tx, span, {
          candidateId: input.candidateId,
          aggregate: `growth_check_in:${row.id}`,
          type: "growth.checked_in",
          actor: "user",
          reason: "Paul logged time on a growth track",
          // The row id and minutes only: the key is Paul's word for the track.
          payload: { checkInId: row.id, minutes: input.minutes },
          idempotencyKey: `growth-check-in:${row.id}`,
          at: row.at,
        });
        return { ok: true as const, status: "recorded" as const };
      }),
    ),
  );
}

// Check-ins since a time, oldest first.
export async function readCheckIns(
  db: Db,
  candidateId: CandidateId,
  since: Date,
): Promise<StoredCheckIn[]> {
  const rows = await guarded("growth.read", () =>
    db
      .select()
      .from(growthCheckIn)
      .where(and(eq(growthCheckIn.candidateId, candidateId), gte(growthCheckIn.checkedInAt, since)))
      .orderBy(asc(growthCheckIn.checkedInAt), asc(growthCheckIn.id)),
  );
  return rows.map((r) => ({
    key: r.trackKey,
    at: r.checkedInAt,
    minutes: r.minutes,
    percent: r.percent,
  }));
}

export type StoredReview = {
  weekStart: string;
  moved: { key: string; minutes: number; plannedMinutes: number }[];
  notReached: string[];
};

const reviewOf = (weekStart: string, review: Record<string, unknown>): StoredReview => ({
  weekStart,
  moved: (review.moved ?? []) as StoredReview["moved"],
  notReached: (review.notReached ?? []) as string[],
});

// One week's review (NS-214, GRW-007), stored once: a second call returns the first.
export async function saveWeekReview(
  db: Db,
  input: {
    candidateId: CandidateId;
    weekStart: string;
    moved: StoredReview["moved"];
    notReached: string[];
  },
): Promise<StoredReview & { status: "reviewed" | "existing" }> {
  return guarded("growth.reviewed", () =>
    inSpan("growth.reviewed", { "northstar.growth.moved": input.moved.length }, (span) =>
      db.transaction(async (tx) => {
        const [row] = await tx
          .insert(growthReview)
          .values({
            candidateId: input.candidateId,
            weekStart: input.weekStart,
            review: { moved: input.moved, notReached: input.notReached },
          })
          .onConflictDoNothing({ target: [growthReview.candidateId, growthReview.weekStart] })
          .returning({ id: growthReview.id, createdAt: growthReview.createdAt });
        if (!row) {
          const [theirs] = await tx
            .select()
            .from(growthReview)
            .where(
              and(
                eq(growthReview.candidateId, input.candidateId),
                eq(growthReview.weekStart, input.weekStart),
              ),
            );
          if (!theirs) throw new Error("growth_review insert returned no row");
          return { ...reviewOf(theirs.weekStart, theirs.review), status: "existing" as const };
        }
        await appendEvent(tx, span, {
          candidateId: input.candidateId,
          aggregate: `growth_review:${row.id}`,
          type: "growth.reviewed",
          actor: "user",
          reason: "Paul reviewed a week of growth time",
          payload: {
            reviewId: row.id,
            weekStart: input.weekStart,
            moved: input.moved.length,
            notReached: input.notReached.length,
          },
          idempotencyKey: `growth-reviewed:${input.weekStart}`,
          at: row.createdAt,
        });
        return {
          weekStart: input.weekStart,
          moved: input.moved,
          notReached: input.notReached,
          status: "reviewed" as const,
        };
      }),
    ),
  );
}

// The stored review of a week, or null.
export async function readWeekReview(
  db: Db,
  candidateId: CandidateId,
  weekStart: string,
): Promise<StoredReview | null> {
  const [row] = await guarded("growth.read", () =>
    db
      .select()
      .from(growthReview)
      .where(and(eq(growthReview.candidateId, candidateId), eq(growthReview.weekStart, weekStart))),
  );
  return row ? reviewOf(row.weekStart, row.review) : null;
}
