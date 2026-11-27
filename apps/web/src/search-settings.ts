import { z } from "zod";

// Settings → Search (NS-199 slice 3, SRC-015/017): the fresh-job alert settings as the API
// answers them, in words, and the request bodies the page sends. The API checks every value with
// the same function as `jobs alerts set`; the checks here only keep an obviously bad value from
// being sent.

// The setting words: a copy of ALERT_FIELD_WORDS in packages/sources (the web app holds no server
// package).
export const ALERT_FIELDS = ["quiet", "zone", "tier1"] as const;
export type AlertField = (typeof ALERT_FIELDS)[number];

const Source = z.enum(["stored", "default"]);
export const AlertSettingsBody = z.object({
  quiet: z.string(),
  timeZone: z.string(),
  tier1InQuietHours: z.boolean(),
  sources: z.object({ quiet: Source, timeZone: Source, tier1: Source }),
  unknownStoredZone: z.boolean(),
});
export type AlertSettings = z.infer<typeof AlertSettingsBody>;

export type SettingRow = { field: AlertField; label: string; value: string; source: string };

const from = (s: "stored" | "default") => (s === "stored" ? "set here" : "default");

// Each setting in words, with where it comes from (UX-020: never colour alone).
export function alertRows(s: AlertSettings): SettingRow[] {
  return [
    {
      field: "quiet",
      label: "Quiet hours",
      value: s.quiet === "off" ? "off" : s.quiet.replace("-", " to "),
      source: from(s.sources.quiet),
    },
    {
      field: "zone",
      label: "Time zone",
      value: s.timeZone,
      source: s.unknownStoredZone
        ? "default (the zone set here isn't known, so the default is used)"
        : from(s.sources.timeZone),
    },
    {
      field: "tier1",
      label: "Tier-1 boards alert in quiet hours",
      value: s.tier1InQuietHours ? "yes" : "no",
      source: from(s.sources.tier1),
    },
  ];
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// Quiet hours from the form: off, or two different HH:MM times. Null when they can't be sent.
export function quietValue(off: boolean, start: string, end: string): string | null {
  if (off) return "off";
  return HHMM.test(start) && HHMM.test(end) && start !== end ? `${start}-${end}` : null;
}

// The POST body for one setting: a value, or null to put it back to its default.
export const changeBody = (field: AlertField, value: string | null) =>
  JSON.stringify({ field, value });

// What the page says after a save, from the API's status and `saved` flag.
export function saveWords(status: number, saved: boolean | null): string {
  if (status === 200) return saved ? "Saved. The next alert pass uses it." : "Already set.";
  if (status === 400) return "Not saved: Northstar didn't accept that value.";
  if (status === 401) return "Not saved: sign in again.";
  return "Not saved. Try again in a moment.";
}
