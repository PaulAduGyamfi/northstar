import type { AlertSettingsChange, AlertSettingsRefusal, StoredAlertSettings } from "@northstar/db";
import {
  ALERT_FIELD_WORDS,
  type AlertConfig,
  alertChange,
  alertReset,
  alertSettingsView,
} from "@northstar/sources";
import { z } from "zod";
import { type AnyEndpoint, endpoint } from "./endpoint.js";

// Paul's fresh-job alert settings on Settings → Search (NS-199 slice 3, SRC-015/017): quiet
// hours, their time zone and the tier-1 rule, stored over the ALERT_* defaults. Session only, and
// a change is always his: nothing in the body names who made it. A value is checked by the same
// `alertChange` as `jobs alerts set`, so the page can store nothing the CLI would refuse.
// bin.ts wires packages/db, tests fake it.

export type AlertSettingsPorts = {
  // The ALERT_* settings as checked at startup, or the name of the one that failed (never its
  // value): bad defaults don't stop the API, only these two routes.
  defaults: { ok: true; value: AlertConfig } | { ok: false; setting: string };
  read: () => Promise<StoredAlertSettings | null>;
  save: (
    change: AlertSettingsChange,
  ) => Promise<
    | { ok: true; value: { saved: boolean; settings: StoredAlertSettings } }
    | { ok: false; error: AlertSettingsRefusal }
  >;
};

const Source = z.enum(["stored", "default"]);
const View = z.object({
  quiet: z.string(),
  timeZone: z.string(),
  tier1InQuietHours: z.boolean(),
  sources: z.object({ quiet: Source, timeZone: Source, tier1: Source }),
  unknownStoredZone: z.boolean(),
});

// One setting word and its text, at most a short line; null puts it back to its default.
const Change = z.object({
  field: z.enum(ALERT_FIELD_WORDS),
  value: z.string().max(64).nullable(),
});

const unavailable = { ok: false, status: 503, error: "unavailable" } as const;
const badDefaults = { ok: false, status: 503, error: "alert_defaults_invalid" } as const;

export function alertSettingsEndpoints(ports: AlertSettingsPorts): AnyEndpoint[] {
  const read = endpoint({
    method: "GET",
    path: "/settings/alerts",
    auth: "session",
    input: z.object({}),
    output: View,
    handler: async () => {
      if (!ports.defaults.ok) return badDefaults;
      let stored: StoredAlertSettings | null;
      try {
        stored = await ports.read();
      } catch {
        return unavailable;
      }
      return { ok: true, body: alertSettingsView(ports.defaults.value, stored) };
    },
  });

  const set = endpoint({
    method: "POST",
    path: "/settings/alerts",
    auth: "session",
    input: Change,
    output: z.object({ saved: z.boolean(), settings: View }),
    handler: async ({ field, value }) => {
      if (!ports.defaults.ok) return badDefaults;
      const change = value === null ? alertReset(field) : alertChange(field, value);
      // Refused before anything is stored, naming the field only.
      if (!change) return { ok: false, status: 400, error: "invalid_value" };
      let result: Awaited<ReturnType<AlertSettingsPorts["save"]>>;
      try {
        result = await ports.save(change);
      } catch {
        return unavailable;
      }
      // The store's own check is a backstop: alertChange already refuses what it refuses.
      if (!result.ok) return { ok: false, status: 400, error: "invalid_value" };
      return {
        ok: true,
        body: {
          saved: result.value.saved,
          settings: alertSettingsView(ports.defaults.value, result.value.settings),
        },
      };
    },
  });

  return [read, set];
}
