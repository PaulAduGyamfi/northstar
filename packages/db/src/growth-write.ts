import { createHash } from "node:crypto";
import type { CandidateId } from "@northstar/domain";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import {
  growthPlan,
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
          await tx.insert(growthTrack).values(
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
            })),
          );
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
  const touches =
    keys.length === 0
      ? []
      : await db
          .select({ key: growthTouch.trackKey, at: sql<Date>`max(${growthTouch.touchedAt})` })
          .from(growthTouch)
          .where(and(eq(growthTouch.candidateId, candidateId), inArray(growthTouch.trackKey, keys)))
          .groupBy(growthTouch.trackKey);
  const last = new Map(touches.map((t) => [t.key, new Date(t.at)]));
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
          .returning({ id: growthPlan.id, createdAt: growthPlan.createdAt });
        if (!row) throw new Error("growth_plan insert returned no row");
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
