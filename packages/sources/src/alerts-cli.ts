import type { AlertSettingsChange, AlertSettingsRefusal, StoredAlertSettings } from "@northstar/db";
import {
  type AlertConfig,
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
type FieldWord = keyof typeof FIELD;
const isField = (w: string | undefined): w is FieldWord => w !== undefined && w in FIELD;

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

// Parses one `set` value into a change, or null when the value is bad.
function changeOf(field: FieldWord, raw: string): AlertSettingsChange | null {
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

const BAD_VALUE: Record<FieldWord, string> = {
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
    const change = changeOf(field, value.join(" "));
    if (!change) {
      deps.print(BAD_VALUE[field]);
      return 1;
    }
    return save(deps, change);
  }
  if (action === "reset" && isField(field) && value.length === 0) {
    return save(deps, { [FIELD[field]]: null });
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

async function show(
  deps: AlertsCliDeps & { print: (line: string) => void },
  stored?: StoredAlertSettings | null,
): Promise<number> {
  const e = effectiveAlertConfig(deps.defaults, stored === undefined ? await deps.read() : stored);
  const from = (s: "stored" | "default") => (s === "stored" ? "set here" : "default");
  const q = e.config.quiet;
  deps.print(
    `Quiet hours: ${q === null ? "off" : `${hhmm(q.start)}-${hhmm(q.end)}`} (${from(e.sources.quiet)})`,
  );
  deps.print(
    `Time zone: ${e.config.timeZone} (${from(e.sources.timeZone)}${e.unknownStoredZone ? "; the zone set here isn't known on this machine" : ""})`,
  );
  deps.print(
    `Tier-1 boards alert in quiet hours: ${e.config.tier1InQuietHours ? "yes" : "no"} (${from(e.sources.tier1)})`,
  );
  return 0;
}
