import type { AlertCandidate, AlertInput } from "@northstar/db";
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

// The alert settings from the environment (bin.ts passes process.env). A bad value is refused by
// its setting's name, never echoed.
export function loadAlertConfig(
  env: Record<string, string | undefined>,
  machineZone: string,
): AlertConfigResult {
  const rawQuiet = (env.ALERT_QUIET_HOURS ?? "").trim() || "22:00-07:00";
  let quiet: AlertConfig["quiet"] = null;
  if (rawQuiet !== "off") {
    const [a, b, ...rest] = rawQuiet.split("-");
    const start = toMinutes(a ?? "");
    const end = toMinutes(b ?? "");
    // Equal ends would mean "always quiet" or "never": refused as unclear.
    if (rest.length > 0 || start === null || end === null || start === end) {
      return { ok: false, setting: "ALERT_QUIET_HOURS" };
    }
    quiet = { start, end };
  }
  const timeZone = (env.ALERT_TIME_ZONE ?? "").trim() || machineZone;
  if (!validZone(timeZone)) return { ok: false, setting: "ALERT_TIME_ZONE" };
  const rawTier = (env.ALERT_TIER1_IN_QUIET_HOURS ?? "").trim() || "true";
  if (rawTier !== "true" && rawTier !== "false") {
    return { ok: false, setting: "ALERT_TIER1_IN_QUIET_HOURS" };
  }
  return { ok: true, value: { quiet, timeZone, tier1InQuietHours: rawTier === "true" } };
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
};

export type AlertCounts = { sent: number; held: number; released: number };

// One alert pass over the queue-band jobs. Safe to repeat: the keys store each decision once.
export function alertPass(store: AlertStore, now: Date, config: AlertConfig): Promise<AlertCounts> {
  return trace
    .getTracer("@northstar/sources")
    .startActiveSpan("sources.fresh_alerts", async (span): Promise<AlertCounts> => {
      try {
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
