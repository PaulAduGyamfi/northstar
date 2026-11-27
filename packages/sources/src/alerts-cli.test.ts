import type { AlertSettingsChange, StoredAlertSettings } from "@northstar/db";
import { describe, expect, it } from "vitest";
import {
  type AlertConfig,
  effectiveAlertConfig,
  parseQuietHours,
  parseTier1,
  parseTimeZone,
  settingsSource,
} from "./alerts.js";
import { alertsCommand } from "./alerts-cli.js";

// Fresh-job alert settings stored over the ALERT_* defaults (NS-199 slice 2). Synthetic values.

const DEFAULTS: AlertConfig = {
  quiet: { start: 22 * 60, end: 7 * 60 },
  timeZone: "America/New_York",
  tier1InQuietHours: true,
};
const NONE: StoredAlertSettings = { quiet: null, timeZone: null, tier1InQuietHours: null };

describe("effectiveAlertConfig", () => {
  it("uses every default when nothing is stored", () => {
    const e = effectiveAlertConfig(DEFAULTS, null);
    expect(e.config).toEqual(DEFAULTS);
    expect(settingsSource(e)).toBe("default");
  });

  it("takes each stored field and falls back to the default for the others", () => {
    const e = effectiveAlertConfig(DEFAULTS, { ...NONE, quiet: { start: 60, end: 120 } });
    expect(e.config).toEqual({ ...DEFAULTS, quiet: { start: 60, end: 120 } });
    expect(e.sources).toEqual({ quiet: "stored", timeZone: "default", tier1: "default" });
    expect(settingsSource(e)).toBe("mixed");
  });

  it("turns quiet hours off when Paul stored off, over default quiet hours", () => {
    const e = effectiveAlertConfig(DEFAULTS, { ...NONE, quiet: "off" });
    expect(e.config.quiet).toBeNull();
    expect(e.sources.quiet).toBe("stored");
  });

  it("uses every stored field when all three are set", () => {
    const e = effectiveAlertConfig(DEFAULTS, {
      quiet: "off",
      timeZone: "Europe/Berlin",
      tier1InQuietHours: false,
    });
    expect(e.config).toEqual({ quiet: null, timeZone: "Europe/Berlin", tier1InQuietHours: false });
    expect(settingsSource(e)).toBe("stored");
  });

  it("falls back to the default zone when the stored zone isn't known here, and says so", () => {
    const e = effectiveAlertConfig(DEFAULTS, { ...NONE, timeZone: "Mars/Olympus_Mons" });
    expect(e.config.timeZone).toBe("America/New_York");
    expect(e.sources.timeZone).toBe("default");
    expect(e.unknownStoredZone).toBe(true);
  });
});

describe("the shared setting parsers", () => {
  it("reads quiet hours that wrap midnight, and off", () => {
    expect(parseQuietHours("22:00-07:00")).toEqual({ quiet: { start: 1320, end: 420 } });
    expect(parseQuietHours(" off ")).toEqual({ quiet: null });
  });

  it("refuses equal ends, a bad time or a third part", () => {
    expect(parseQuietHours("07:00-07:00")).toBeNull();
    expect(parseQuietHours("24:00-07:00")).toBeNull();
    expect(parseQuietHours("01:00-02:00-03:00")).toBeNull();
  });

  it("accepts only a zone the runtime knows, and only true or false for tier 1", () => {
    expect(parseTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
    expect(parseTimeZone("Nowhere/Land")).toBeNull();
    expect(parseTimeZone("")).toBeNull();
    expect(parseTier1("false")).toBe(false);
    expect(parseTier1("yes")).toBeNull();
  });
});

// A CLI over an in-memory store that merges like setAlertSettings.
function cli(initial: StoredAlertSettings | null = null) {
  let stored = initial;
  const saved: AlertSettingsChange[] = [];
  const lines: string[] = [];
  const deps = {
    defaults: DEFAULTS,
    print: (l: string) => lines.push(l),
    read: async () => stored,
    save: async (change: AlertSettingsChange) => {
      saved.push(change);
      const next = { ...(stored ?? NONE), ...change };
      const same = JSON.stringify(next) === JSON.stringify(stored ?? NONE);
      stored = next;
      return { ok: true as const, value: { saved: !same, settings: next } };
    },
  };
  return { run: (...argv: string[]) => alertsCommand(deps, argv), lines, saved };
}

describe("jobs alerts", () => {
  it("prints each setting in effect and where it comes from", async () => {
    const c = cli({ ...NONE, tier1InQuietHours: false });
    expect(await c.run("alerts")).toBe(0);
    expect(c.lines).toEqual([
      "Quiet hours: 22:00-07:00 (default)",
      "Time zone: America/New_York (default)",
      "Tier-1 boards alert in quiet hours: no (set here)",
    ]);
  });

  it("stores quiet hours set with the env's own format, then prints them as set here", async () => {
    const c = cli();
    expect(await c.run("alerts", "set", "quiet", "23:30-06:15")).toBe(0);
    expect(c.saved).toEqual([{ quiet: { start: 1410, end: 375 } }]);
    expect(c.lines[0]).toBe("Saved. The next alert pass uses it.");
    expect(c.lines[1]).toBe("Quiet hours: 23:30-06:15 (set here)");
  });

  it("stores off as no quiet hours", async () => {
    const c = cli();
    await c.run("alerts", "set", "quiet", "off");
    expect(c.saved).toEqual([{ quiet: "off" }]);
    expect(c.lines[1]).toBe("Quiet hours: off (set here)");
  });

  it("refuses a bad value with nothing stored", async () => {
    const c = cli();
    expect(await c.run("alerts", "set", "zone", "Nowhere/Land")).toBe(1);
    expect(await c.run("alerts", "set", "quiet", "09:00-09:00")).toBe(1);
    expect(await c.run("alerts", "set", "tier1", "maybe")).toBe(1);
    expect(c.saved).toEqual([]);
    expect(c.lines).toEqual([
      "That isn't a time zone this machine knows (an IANA name such as Europe/Berlin).",
      "Quiet hours must be HH:MM-HH:MM with two different times, or off.",
      "Tier-1 must be true or false.",
    ]);
  });

  it("puts one field back to its default with reset", async () => {
    const c = cli({ ...NONE, timeZone: "Asia/Tokyo" });
    expect(await c.run("alerts", "reset", "zone")).toBe(0);
    expect(c.saved).toEqual([{ timeZone: null }]);
    expect(c.lines[1]).toBe("Quiet hours: 22:00-07:00 (default)");
    expect(c.lines[2]).toBe("Time zone: America/New_York (default)");
  });

  it("says nothing changed when the value is already set", async () => {
    const c = cli({ ...NONE, tier1InQuietHours: true });
    await c.run("alerts", "set", "tier1", "true");
    expect(c.lines[0]).toBe("Already set; nothing changed.");
  });

  it("prints its usage for an unknown field or a missing value", async () => {
    const c = cli();
    expect(await c.run("alerts", "set", "volume", "11")).toBe(1);
    expect(await c.run("alerts", "set", "quiet")).toBe(1);
    expect(c.lines.every((l) => l.startsWith("usage: jobs alerts"))).toBe(true);
  });

  it("leaves other commands to the caller", async () => {
    expect(await cli().run("form", "j1")).toBeNull();
  });
});
