import { basename } from "node:path";
import type {
  GrowthSettingsInput,
  GrowthTrackInput,
  GrowthTrackView,
  StoredPlan,
} from "@northstar/db";
import {
  DEFAULT_PLAN_SETTINGS,
  type GrowthTrack,
  type PlanSettings,
  parsePlanSettings,
  planWeek,
  type WeekPlan,
  weekStartOf,
} from "@northstar/domain";
import { parseGrowthTracks } from "./growth-file.js";

// `profile growth …` (NS-210, GRW-001…004): Paul's growth tracks, touches, planner settings and
// each week's plan. Plain code over his own data; it prints his tracks back to him only.

export type GrowthCliDeps = {
  print: (line: string) => void;
  readText: (path: string) => Promise<string>;
  now: () => Date;
  setGrowthTracks: (
    tracks: GrowthTrackInput[],
  ) => Promise<{ status: "set" | "unchanged"; version: number; tracks: number }>;
  readGrowthTracks: () => Promise<{ version: number; tracks: GrowthTrackView[] } | null>;
  recordGrowthTouch: (
    key: string,
  ) => Promise<{ ok: true } | { ok: false; error: { kind: "UnknownTrack" } }>;
  readGrowthSettings: () => Promise<GrowthSettingsInput | null>;
  setGrowthSettings: (settings: GrowthSettingsInput) => Promise<void>;
  saveWeekPlan: (input: {
    weekStart: string;
    trackSetVersion: number;
    plan: Record<string, unknown>;
    counts: { focus: number; maintenance: number; atRisk: number };
  }) => Promise<StoredPlan>;
};

export const GROWTH_USAGE =
  "usage: profile growth tracks set <file> | profile growth tracks | profile growth touch <key> | profile growth settings [set <field> <value>] | profile growth plan";

const SETTING_FIELDS = [
  "weeklyMinutes",
  "wipLimit",
  "blockMinutes",
  "maintenanceMinutes",
  "minFocusSessions",
] as const;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

// The Monday (UTC) of the week: lives in packages/domain since NS-214, so the API shares it.
export { weekStartOf };

export async function growthCommand(deps: GrowthCliDeps, args: string[]): Promise<number> {
  const [sub, a, b, c, ...rest] = args;
  if (rest.length > 0) return usage(deps);
  if (sub === "tracks" && a === "set" && b && c === undefined) return tracksSet(deps, b);
  if (sub === "tracks" && a === undefined) return tracksShow(deps);
  if (sub === "touch" && a && b === undefined) return touch(deps, a);
  if (sub === "settings" && a === undefined) return settingsShow(deps);
  if (sub === "settings" && a === "set" && b && c !== undefined) return settingsSet(deps, b, c);
  if (sub === "plan" && a === undefined) return plan(deps);
  return usage(deps);
}

function usage(deps: GrowthCliDeps): number {
  deps.print(GROWTH_USAGE);
  return 1;
}

async function tracksSet(deps: GrowthCliDeps, path: string): Promise<number> {
  const name = basename(path);
  const parsed = parseGrowthTracks(await deps.readText(path));
  if (!parsed.ok) {
    deps.print(`${name}: nothing stored. Fix these lines first:`);
    for (const p of parsed.error) deps.print(`  line ${p.line}: ${p.problem}`);
    return 1;
  }
  const r = await deps.setGrowthTracks(parsed.value);
  deps.print(
    r.status === "set"
      ? `${name}: stored version ${r.version} (${plural(r.tracks, "track")}).`
      : `${name}: unchanged, still version ${r.version}.`,
  );
  return 0;
}

async function tracksShow(deps: GrowthCliDeps): Promise<number> {
  const current = await deps.readGrowthTracks();
  if (current === null) {
    deps.print("No growth tracks yet. Run: profile growth tracks set data/<file>");
    return 0;
  }
  for (const t of current.tracks) {
    const touched = t.lastTouchedAt ? t.lastTouchedAt.toISOString().slice(0, 10) : "never";
    deps.print(
      `${t.key}: ${t.name} (${t.type}, ${t.status}, priority ${t.priority}) · last touched ${touched}`,
    );
    // GRW-001/002 (NS-232): only what the file gave.
    if (t.goal !== undefined) deps.print(`  goal: ${t.goal}`);
    if (t.doneWhen !== undefined) deps.print(`  done when: ${t.doneWhen}`);
    for (const m of t.milestones ?? []) {
      deps.print(
        `  ${m.doneOn === null ? "[ ]" : "[x]"} ${m.title}${m.doneOn ? ` (done ${m.doneOn})` : ""}`,
      );
    }
  }
  return 0;
}

async function touch(deps: GrowthCliDeps, key: string): Promise<number> {
  const r = await deps.recordGrowthTouch(key);
  if (!r.ok) {
    deps.print(`No current track has the key ${key}. See profile growth tracks.`);
    return 1;
  }
  deps.print(`Noted: you worked on ${key}.`);
  return 0;
}

const currentSettings = async (deps: GrowthCliDeps): Promise<PlanSettings> =>
  (await deps.readGrowthSettings()) ?? DEFAULT_PLAN_SETTINGS;

async function settingsShow(deps: GrowthCliDeps): Promise<number> {
  const s = await currentSettings(deps);
  for (const f of SETTING_FIELDS) deps.print(`${f}: ${s[f]}`);
  return 0;
}

async function settingsSet(deps: GrowthCliDeps, field: string, raw: string): Promise<number> {
  if (!(SETTING_FIELDS as readonly string[]).includes(field)) {
    deps.print(`Not saved: unknown setting. Settings: ${SETTING_FIELDS.join(", ")}`);
    return 1;
  }
  const value = /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
  const next = parsePlanSettings({ ...(await currentSettings(deps)), [field]: value });
  if (!next.ok) {
    deps.print(`Not saved: ${field} is out of range.`);
    return 1;
  }
  await deps.setGrowthSettings(next.value);
  deps.print(`Saved ${field}: ${value}.`);
  return 0;
}

const NOTE_WORDS = {
  over_capacity: "moved out of focus: not enough hours",
  no_time: "no time left this week",
};
const UNPLANNED_WORDS = { paused: "paused", backlogged: "in the backlog", done: "done" };

async function plan(deps: GrowthCliDeps): Promise<number> {
  const current = await deps.readGrowthTracks();
  if (current === null || current.tracks.length === 0) {
    deps.print("No growth tracks yet. Run: profile growth tracks set data/<file>");
    return 0;
  }
  const now = deps.now();
  const tracks: GrowthTrack[] = current.tracks.map((t) => ({
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
  const computed = planWeek(tracks, await currentSettings(deps), now);
  const stored = await deps.saveWeekPlan({
    weekStart: weekStartOf(now),
    trackSetVersion: current.version,
    plan: computed as unknown as Record<string, unknown>,
    counts: {
      focus: computed.focus.length,
      maintenance: computed.maintenance.length,
      atRisk: computed.atRisk.length,
    },
  });
  const week = stored.plan as unknown as WeekPlan;
  const names = new Map(current.tracks.map((t) => [t.key, t.name]));
  const label = (key: string) => `${key} (${names.get(key) ?? "no longer a track"})`;
  deps.print(
    stored.status === "planned"
      ? `Plan for the week of ${stored.weekStart}:`
      : `Plan for the week of ${stored.weekStart} (already made; it stays as it was):`,
  );
  deps.print("Focus:");
  for (const f of week.focus) deps.print(`  ${label(f.trackId)}: ${f.blocks.join(" + ")} min`);
  if (week.focus.length === 0) deps.print("  none");
  deps.print("Maintenance:");
  for (const m of week.maintenance)
    deps.print(`  ${label(m.trackId)}: ${m.blocks.join(" + ")} min`);
  if (week.maintenance.length === 0) deps.print("  none");
  if (week.atRisk.length > 0) deps.print(`At risk: ${week.atRisk.map(label).join(", ")}`);
  if (week.needsNextAction.length > 0) {
    deps.print(
      `Needs a next action of 90 min or less: ${week.needsNextAction.map(label).join(", ")}`,
    );
  }
  for (const n of week.notes) deps.print(`Note: ${label(n.trackId)}: ${NOTE_WORDS[n.note]}`);
  for (const u of week.unplanned)
    deps.print(`Not planned: ${label(u.trackId)}: ${UNPLANNED_WORDS[u.reason]}`);
  return 0;
}
