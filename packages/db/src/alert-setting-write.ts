import type { CandidateId } from "@northstar/domain";
import { desc, eq } from "drizzle-orm";
import { alertSetting } from "./alert-setting-schema.js";
import type { Db } from "./db.js";
import { appendEvent, inSpan } from "./resilience-event.js";

// Paul's fresh-job alert settings (NS-199 slice 2, SRC-015/017): the only writer and reader of
// alert_setting. A null field means "use the ALERT_* default" (packages/sources merges them).

// Quiet hours: off, or a range in minutes after local midnight (it may wrap midnight).
export type StoredQuiet = "off" | { start: number; end: number };

export type StoredAlertSettings = {
  quiet: StoredQuiet | null;
  timeZone: string | null;
  tier1InQuietHours: boolean | null;
};

// One change: each field given is set (null puts it back to the default); absent fields keep the
// newest stored value.
export type AlertSettingsChange = Partial<StoredAlertSettings>;

export type AlertSettingField = "quiet" | "timeZone" | "tier1InQuietHours";

export type AlertSettingsRefusal = {
  kind: "InvalidAlertSettings";
  // Which fields failed, by name only.
  fields: AlertSettingField[];
};

// The same bounds as the table's CHECKs, so a bad input is a typed refusal, never a database error.
const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/;
const minuteOk = (n: number) => Number.isInteger(n) && n >= 0 && n <= 1439;

function invalidFields(change: AlertSettingsChange): AlertSettingField[] {
  const bad: AlertSettingField[] = [];
  const q = change.quiet;
  if (
    q !== undefined &&
    q !== null &&
    q !== "off" &&
    !(minuteOk(q.start) && minuteOk(q.end) && q.start !== q.end)
  )
    bad.push("quiet");
  if (
    change.timeZone !== undefined &&
    change.timeZone !== null &&
    !ZONE_SHAPE.test(change.timeZone)
  )
    bad.push("timeZone");
  if (
    change.tier1InQuietHours !== undefined &&
    change.tier1InQuietHours !== null &&
    typeof change.tier1InQuietHours !== "boolean"
  )
    bad.push("tier1InQuietHours");
  return bad;
}

const sameQuiet = (a: StoredQuiet | null, b: StoredQuiet | null) =>
  a === null || b === null || a === "off" || b === "off"
    ? a === b
    : a.start === b.start && a.end === b.end;

// Paul's newest alert settings, or null before he sets any.
export async function readAlertSettings(
  db: Pick<Db, "select">,
  candidateId: CandidateId,
): Promise<StoredAlertSettings | null> {
  const [row] = await db
    .select({
      quietKind: alertSetting.quietKind,
      quietStart: alertSetting.quietStart,
      quietEnd: alertSetting.quietEnd,
      timeZone: alertSetting.timeZone,
      tier1InQuietHours: alertSetting.tier1InQuietHours,
    })
    .from(alertSetting)
    .where(eq(alertSetting.candidateId, candidateId))
    .orderBy(desc(alertSetting.position))
    .limit(1);
  if (!row) return null;
  const quiet: StoredQuiet | null =
    row.quietKind === "off"
      ? "off"
      : row.quietKind === "range" && row.quietStart !== null && row.quietEnd !== null
        ? { start: row.quietStart, end: row.quietEnd }
        : null;
  return { quiet, timeZone: row.timeZone, tier1InQuietHours: row.tier1InQuietHours };
}

const EMPTY: StoredAlertSettings = { quiet: null, timeZone: null, tier1InQuietHours: null };

// Merges one change into the newest settings and stores the result as a new version, with an
// `alerts.settings_changed` event naming the changed fields. A change that alters nothing stores
// nothing.
export async function setAlertSettings(
  db: Db,
  input: { candidateId: CandidateId; change: AlertSettingsChange },
): Promise<
  | { ok: true; value: { saved: boolean; settings: StoredAlertSettings } }
  | { ok: false; error: AlertSettingsRefusal }
> {
  const bad = invalidFields(input.change);
  if (bad.length > 0) return { ok: false, error: { kind: "InvalidAlertSettings", fields: bad } };
  try {
    return await inSpan("alerts.settings_set", {}, (span) =>
      db.transaction(async (tx) => {
        const current = (await readAlertSettings(tx, input.candidateId)) ?? EMPTY;
        const next: StoredAlertSettings = {
          quiet: input.change.quiet === undefined ? current.quiet : input.change.quiet,
          timeZone: input.change.timeZone === undefined ? current.timeZone : input.change.timeZone,
          tier1InQuietHours:
            input.change.tier1InQuietHours === undefined
              ? current.tier1InQuietHours
              : input.change.tier1InQuietHours,
        };
        const changed: AlertSettingField[] = [];
        if (!sameQuiet(current.quiet, next.quiet)) changed.push("quiet");
        if (current.timeZone !== next.timeZone) changed.push("timeZone");
        if (current.tier1InQuietHours !== next.tier1InQuietHours) changed.push("tier1InQuietHours");
        span.setAttribute("northstar.alerts.changed", changed.length);
        // Two identical changes racing may both store a row; the settings are the same either way.
        if (changed.length === 0) return { ok: true, value: { saved: false, settings: current } };
        const q = next.quiet;
        const [row] = await tx
          .insert(alertSetting)
          .values({
            candidateId: input.candidateId,
            quietKind: q === null ? null : q === "off" ? "off" : "range",
            quietStart: q !== null && q !== "off" ? q.start : null,
            quietEnd: q !== null && q !== "off" ? q.end : null,
            timeZone: next.timeZone,
            tier1InQuietHours: next.tier1InQuietHours,
          })
          .returning({ id: alertSetting.id, createdAt: alertSetting.createdAt });
        if (!row) throw new Error("alert_setting insert returned no row");
        await appendEvent(tx, span, {
          candidateId: input.candidateId,
          aggregate: `alert_setting:${row.id}`,
          type: "alerts.settings_changed",
          actor: "user",
          // Fixed words only: the feed shows this sentence.
          reason: "You changed the fresh-job alert settings",
          // Field names only: a time zone says where Paul lives.
          payload: { settingId: row.id, changed },
          idempotencyKey: `alert_setting:${row.id}`,
          at: row.createdAt,
        });
        return { ok: true, value: { saved: true, settings: next } };
      }),
    );
  } catch {
    // A fresh error with no cause: the driver's message lists the query's parameters.
    throw new Error("alerts.settings_set failed");
  }
}
