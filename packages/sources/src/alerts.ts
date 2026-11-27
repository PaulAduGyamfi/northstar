import type { AlertCandidate, AlertInput, StoredAlertSettings } from "@northstar/db";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { detectAts } from "./ats/detect.js";
import { ageHours } from "./queue.js";

// Fresh-job alerts (NS-163, SRC-015). Plain code, no model: a job whose latest score is in the
// queue band and that is under an hour old gets one alert. Inside quiet hours it is held, unless
// it comes from a tier-1 watched board and tier-1 alerts may break quiet hours; a held alert goes
// out on the first pass after they end. Each job is alerted at most once (keys in packages/db).

export const FRESH_MINUTES = 60;

// The start of the freshness window at `now`: only jobs whose age time is after it can still get
// a first alert (NS-199). The alert read uses it, so it must match decideAlert's FRESH_MINUTES.
export function freshSince(now: Date): Date {
  return new Date(now.getTime() - FRESH_MINUTES * 60_000);
}

export type AlertConfig = {
  // Minutes after local midnight; null when quiet hours are off.
  quiet: { start: number; end: number } | null;
  timeZone: string;
  tier1InQuietHours: boolean;
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMinutes = (hhmm: string) => {
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

const validZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

// A setting refused at startup, named so the message can say which one (never its value).
export class AlertSettingError extends Error {
  constructor(readonly setting: string) {
    super("bad setting");
    this.name = "AlertSettingError";
  }
}

export type AlertConfigResult = { ok: true; value: AlertConfig } | { ok: false; setting: string };

// Quiet hours as written in ALERT_QUIET_HOURS or `jobs alerts set quiet`: `HH:MM-HH:MM` (it may
// wrap midnight) or `off`. Null for anything else; equal ends would mean "always quiet" or
// "never", so they are refused as unclear.
export function parseQuietHours(raw: string): { quiet: AlertConfig["quiet"] } | null {
  const text = raw.trim();
  if (text === "off") return { quiet: null };
  const [a, b, ...rest] = text.split("-");
  const start = toMinutes(a ?? "");
  const end = toMinutes(b ?? "");
  if (rest.length > 0 || start === null || end === null || start === end) return null;
  return { quiet: { start, end } };
}

// An IANA time zone the runtime knows, or null.
export function parseTimeZone(raw: string): string | null {
  const zone = raw.trim();
  return zone !== "" && validZone(zone) ? zone : null;
}

// `true` or `false`, or null for anything else.
export function parseTier1(raw: string): boolean | null {
  const text = raw.trim();
  return text === "true" ? true : text === "false" ? false : null;
}

// The alert settings from the environment (bin.ts passes process.env). A bad value is refused by
// its setting's name, never echoed. Since NS-199 slice 2 these are the defaults: a stored setting
// wins (effectiveAlertConfig).
export function loadAlertConfig(
  env: Record<string, string | undefined>,
  machineZone: string,
): AlertConfigResult {
  const quiet = parseQuietHours((env.ALERT_QUIET_HOURS ?? "").trim() || "22:00-07:00");
  if (!quiet) return { ok: false, setting: "ALERT_QUIET_HOURS" };
  const timeZone = parseTimeZone((env.ALERT_TIME_ZONE ?? "").trim() || machineZone);
  if (!timeZone) return { ok: false, setting: "ALERT_TIME_ZONE" };
  const tier1InQuietHours = parseTier1((env.ALERT_TIER1_IN_QUIET_HOURS ?? "").trim() || "true");
  if (tier1InQuietHours === null) return { ok: false, setting: "ALERT_TIER1_IN_QUIET_HOURS" };
  return { ok: true, value: { quiet: quiet.quiet, timeZone, tier1InQuietHours } };
}

export type AlertSettingSource = "stored" | "default";

export type EffectiveAlertConfig = {
  config: AlertConfig;
  // Where each value came from, for `jobs alerts` and the alert pass's span.
  sources: { quiet: AlertSettingSource; timeZone: AlertSettingSource; tier1: AlertSettingSource };
  // A stored zone this runtime no longer knows: the default zone is used instead.
  unknownStoredZone: boolean;
};

// Paul's stored alert settings over the ALERT_* defaults, field by field (NS-199 slice 2, SRC-017).
// A null stored field means "use the default".
export function effectiveAlertConfig(
  defaults: AlertConfig,
  stored: StoredAlertSettings | null,
): EffectiveAlertConfig {
  const quiet = stored?.quiet ?? null;
  const storedZone = stored?.timeZone ?? null;
  const zone = storedZone === null ? null : parseTimeZone(storedZone);
  const tier1 = stored?.tier1InQuietHours ?? null;
  return {
    config: {
      quiet: quiet === null ? defaults.quiet : quiet === "off" ? null : quiet,
      timeZone: zone ?? defaults.timeZone,
      tier1InQuietHours: tier1 ?? defaults.tier1InQuietHours,
    },
    sources: {
      quiet: quiet === null ? "default" : "stored",
      timeZone: zone === null ? "default" : "stored",
      tier1: tier1 === null ? "default" : "stored",
    },
    unknownStoredZone: storedZone !== null && zone === null,
  };
}

// One word for the span: every value from the defaults, every one stored, or a mix.
export function settingsSource(e: EffectiveAlertConfig): "default" | "stored" | "mixed" {
  const all = Object.values(e.sources);
  return all.every((s) => s === "default")
    ? "default"
    : all.every((s) => s === "stored")
      ? "stored"
      : "mixed";
}

// Whether `now` falls inside quiet hours in the configured zone. A range can wrap midnight
// (22:00-07:00); its start is inside, its end is not.
export function inQuietHours(now: Date, config: AlertConfig): boolean {
  if (!config.quiet) return false;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const minute = get("hour") * 60 + get("minute");
  const { start, end } = config.quiet;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export type WatchedBoard = { ats: string; board: string; tier: 1 | 2 | 3 };

// The board a posting URL belongs to, by plain URL parsing (no request).
function boardOf(url: string): { ats: string; board: string } | null {
  const t = detectAts(url);
  if (!t) return null;
  switch (t.ats) {
    case "greenhouse":
      return { ats: t.ats, board: t.board };
    case "lever":
    case "smartrecruiters":
      return { ats: t.ats, board: t.company };
    case "ashby":
      return { ats: t.ats, board: t.org };
    case "workable":
      return { ats: t.ats, board: t.account };
    case "workday":
      // Workday boards aren't watched (NS-115).
      return null;
  }
}

// A job's tier: the best (lowest) tier among the watched boards its sources come from, or null.
// Board names compare without case: a tier only decides whether an alert may break quiet hours.
export function jobTier(sourceUrls: readonly string[], watches: readonly WatchedBoard[]) {
  let best: 1 | 2 | 3 | null = null;
  for (const url of sourceUrls) {
    const b = boardOf(url);
    if (!b) continue;
    for (const w of watches) {
      if (w.ats === b.ats && w.board.toLowerCase() === b.board.toLowerCase()) {
        if (best === null || w.tier < best) best = w.tier;
      }
    }
  }
  return best;
}

export type AlertDecision =
  | { kind: "alert"; wasHeld: boolean }
  | { kind: "hold" }
  | { kind: "none"; reason: "already_alerted" | "still_held" | "not_fresh" };

// One job's decision. Pure: the same inputs always give the same answer.
export function decideAlert(
  c: Pick<AlertCandidate, "alerted" | "held">,
  ageMinutes: number,
  tier: 1 | 2 | 3 | null,
  quiet: boolean,
  config: AlertConfig,
): AlertDecision {
  if (c.alerted) return { kind: "none", reason: "already_alerted" };
  const mayBreakQuiet = tier === 1 && config.tier1InQuietHours;
  const mustWait = quiet && !mayBreakQuiet;
  // A held alert goes out once quiet hours end, however old the job is by then.
  if (c.held)
    return mustWait ? { kind: "none", reason: "still_held" } : { kind: "alert", wasHeld: true };
  if (ageMinutes >= FRESH_MINUTES) return { kind: "none", reason: "not_fresh" };
  return mustWait ? { kind: "hold" } : { kind: "alert", wasHeld: false };
}

export type AlertStore = {
  candidates: () => Promise<AlertCandidate[]>;
  watches: () => Promise<WatchedBoard[]>;
  alert: (
    input: Omit<AlertInput, "candidateId"> & { wasHeld: boolean },
  ) => Promise<"recorded" | "exists">;
  hold: (input: Omit<AlertInput, "candidateId">) => Promise<"recorded" | "exists">;
  // Paul's stored settings (NS-199 slice 2), read inside the pass's span so a change needs no
  // restart and a failed read marks the span. Without it the pass uses its config as given.
  settings?: () => Promise<StoredAlertSettings | null>;
};

export type AlertCounts = { sent: number; held: number; released: number };

// One alert pass over the queue-band jobs. Safe to repeat: the keys store each decision once.
// `defaults` are the ALERT_* settings; with a `settings` port, Paul's stored ones win over them.
export function alertPass(
  store: AlertStore,
  now: Date,
  defaults: AlertConfig,
): Promise<AlertCounts> {
  return trace
    .getTracer("@northstar/sources")
    .startActiveSpan("sources.fresh_alerts", async (span): Promise<AlertCounts> => {
      try {
        let config = defaults;
        if (store.settings) {
          const effective = effectiveAlertConfig(defaults, await store.settings());
          config = effective.config;
          span.setAttribute("alerts.settings_source", settingsSource(effective));
        }
        const candidates = await store.candidates();
        const counts: AlertCounts = { sent: 0, held: 0, released: 0 };
        if (candidates.length > 0) {
          const watches = await store.watches();
          const quiet = inQuietHours(now, config);
          for (const c of candidates) {
            // A posting dated in the future counts as just posted (ageHours never goes below 0
            // here).
            const ageMinutes = Math.max(0, ageHours(c.postedAt, c.firstSeenAt, now) * 60);
            const tier = jobTier(c.sourceUrls, watches);
            const d = decideAlert(c, ageMinutes, tier, quiet, config);
            const input = { jobId: c.jobId, score: c.score, ageMinutes, tier, now };
            if (d.kind === "alert") {
              if ((await store.alert({ ...input, wasHeld: d.wasHeld })) === "recorded") {
                if (d.wasHeld) counts.released++;
                else counts.sent++;
              }
            } else if (d.kind === "hold") {
              if ((await store.hold(input)) === "recorded") counts.held++;
            }
          }
        }
        span.setAttribute("alerts.sent", counts.sent);
        span.setAttribute("alerts.held", counts.held);
        span.setAttribute("alerts.released", counts.released);
        return counts;
      } catch (error) {
        // Named only: a database error's detail can quote a row.
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.name : "Error",
        });
        throw error;
      } finally {
        span.end();
      }
    });
}

// After every scoring pass: run the alert pass too. An alert failure never fails scoring or the
// command, but it is never silent either: `onError` gets its name (never its message, which can
// quote a row), the span records it, and the next pass retries safely. A scoring failure skips it.
export async function scoreThenAlert<T>(
  score: () => Promise<T>,
  alerts: () => Promise<unknown>,
  onError: (errorName: string) => void,
): Promise<T> {
  const run = await score();
  try {
    await alerts();
  } catch (error) {
    onError(error instanceof Error ? error.name : "Error");
  }
  return run;
}
