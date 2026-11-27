import type { AlertSettingsChange, AlertSettingsRefusal, StoredAlertSettings } from "@northstar/db";
import {
  type AlertConfig,
  type EffectiveAlertConfig,
  effectiveAlertConfig,
  parseQuietHours,
  parseTier1,
  parseTimeZone,
} from "./alerts.js";

// `jobs alerts`, `jobs alerts set quiet|zone|tier1 <value>` and `jobs alerts reset
// quiet|zone|tier1` (NS-199 slice 2, SRC-015/017): Paul's fresh-job alert settings, stored over
// the ALERT_* defaults. Values are checked by the same parsers as the env settings, so a value
// the alert pass would refuse is never stored. The next alert pass uses a change: no restart.

export type AlertsCliDeps = {
  // The ALERT_* settings (or their built-in defaults), already checked at startup.
  defaults: AlertConfig;
  read: () => Promise<StoredAlertSettings | null>;
  save: (
    change: AlertSettingsChange,
  ) => Promise<
    | { ok: true; value: { saved: boolean; settings: StoredAlertSettings } }
    | { ok: false; error: AlertSettingsRefusal }
  >;
};

export const ALERTS_USAGE =
  "usage: jobs alerts | jobs alerts set quiet <HH:MM-HH:MM|off> | jobs alerts set zone <IANA zone> | jobs alerts set tier1 <true|false> | jobs alerts reset quiet|zone|tier1";

const FIELD = { quiet: "quiet", zone: "timeZone", tier1: "tier1InQuietHours" } as const;
// The three setting words, shared by the CLI and the API.
export const ALERT_FIELD_WORDS = ["quiet", "zone", "tier1"] as const;
export type AlertFieldWord = (typeof ALERT_FIELD_WORDS)[number];
// A reset: the field word's stored change back to the default.
export const alertReset = (field: AlertFieldWord): AlertSettingsChange => ({
  [FIELD[field]]: null,
});
const isField = (w: string | undefined): w is AlertFieldWord =>
  w !== undefined && Object.hasOwn(FIELD, w);

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

// Parses one `set` value into a change, or null when the value is bad. Exported (NS-199 slice 3)
// so the API's Settings → Search route checks a value exactly as `jobs alerts set` does.
export function alertChange(field: AlertFieldWord, raw: string): AlertSettingsChange | null {
  if (field === "quiet") {
    const parsed = parseQuietHours(raw);
    if (!parsed) return null;
    return { quiet: parsed.quiet === null ? "off" : parsed.quiet };
  }
  if (field === "zone") {
    const zone = parseTimeZone(raw);
    return zone === null ? null : { timeZone: zone };
  }
  const tier1 = parseTier1(raw);
  return tier1 === null ? null : { tier1InQuietHours: tier1 };
}

const BAD_VALUE: Record<AlertFieldWord, string> = {
  quiet: "Quiet hours must be HH:MM-HH:MM with two different times, or off.",
  zone: "That isn't a time zone this machine knows (an IANA name such as Europe/Berlin).",
  tier1: "Tier-1 must be true or false.",
};

// Returns null when the arguments aren't a `jobs alerts` command, so the caller prints its usage.
export async function alertsCommand(
  deps: AlertsCliDeps & { print: (line: string) => void },
  argv: string[],
): Promise<number | null> {
  const [command, action, field, ...value] = argv;
  if (command !== "alerts") return null;
  if (action === undefined) return show(deps);
  if (action === "set" && isField(field) && value.length > 0) {
    const change = alertChange(field, value.join(" "));
    if (!change) {
      deps.print(BAD_VALUE[field]);
      return 1;
    }
    return save(deps, change);
  }
  if (action === "reset" && isField(field) && value.length === 0) {
    return save(deps, alertReset(field));
  }
  deps.print(ALERTS_USAGE);
  return 1;
}

async function save(
  deps: AlertsCliDeps & { print: (line: string) => void },
  change: AlertSettingsChange,
): Promise<number> {
  const result = await deps.save(change);
  if (!result.ok) {
    // The parsers above already refuse what the store refuses; this is only a backstop.
    deps.print(`Not saved: ${result.error.fields.join(", ")} refused.`);
    return 1;
  }
  deps.print(
    result.value.saved ? "Saved. The next alert pass uses it." : "Already set; nothing changed.",
  );
  return show(deps, result.value.settings);
}

export type AlertSettingsView = {
  quiet: string;
  timeZone: string;
  tier1InQuietHours: boolean;
  sources: EffectiveAlertConfig["sources"];
  unknownStoredZone: boolean;
};

// The settings in effect as text (`HH:MM-HH:MM` or `off`), with each one's source: what
// `jobs alerts` prints and the API's Settings → Search answer (NS-199 slice 3).
export function alertSettingsView(
  defaults: AlertConfig,
  stored: StoredAlertSettings | null,
): AlertSettingsView {
  const e = effectiveAlertConfig(defaults, stored);
  const q = e.config.quiet;
  return {
    quiet: q === null ? "off" : `${hhmm(q.start)}-${hhmm(q.end)}`,
    timeZone: e.config.timeZone,
    tier1InQuietHours: e.config.tier1InQuietHours,
    sources: e.sources,
    unknownStoredZone: e.unknownStoredZone,
  };
}

async function show(
  deps: AlertsCliDeps & { print: (line: string) => void },
  stored?: StoredAlertSettings | null,
): Promise<number> {
  const v = alertSettingsView(deps.defaults, stored === undefined ? await deps.read() : stored);
  const from = (s: "stored" | "default") => (s === "stored" ? "set here" : "default");
  deps.print(`Quiet hours: ${v.quiet} (${from(v.sources.quiet)})`);
  deps.print(
    `Time zone: ${v.timeZone} (${from(v.sources.timeZone)}${v.unknownStoredZone ? "; the zone set here isn't known on this machine" : ""})`,
  );
  deps.print(
    `Tier-1 boards alert in quiet hours: ${v.tier1InQuietHours ? "yes" : "no"} (${from(v.sources.tier1)})`,
  );
  return 0;
}
