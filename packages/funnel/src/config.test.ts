import { describe, expect, it } from "vitest";
import { FunnelConfigError, loadFunnelConfig, loadPrepConfig } from "./config.js";

// The funnel's settings (NS-238 item 1 slice 2). No real environment is read.

describe("loadFunnelConfig", () => {
  it("reads RECRUITER_EXTRACT as on or off, unset or empty meaning off", () => {
    expect([
      loadFunnelConfig({ RECRUITER_EXTRACT: "on" }),
      loadFunnelConfig({ RECRUITER_EXTRACT: "off" }),
      loadFunnelConfig({ RECRUITER_EXTRACT: "" }),
      loadFunnelConfig({}),
    ]).toEqual([
      { recruiterExtract: true },
      { recruiterExtract: false },
      { recruiterExtract: false },
      { recruiterExtract: false },
    ]);
  });

  it("refuses any other value by the setting's name, never echoing the value", () => {
    let caught: unknown;
    try {
      loadFunnelConfig({ RECRUITER_EXTRACT: "yes-please" });
    } catch (e) {
      caught = e;
    }
    expect([
      caught instanceof FunnelConfigError,
      (caught as Error).message,
      (caught as Error).message.includes("yes-please"),
    ]).toEqual([true, "RECRUITER_EXTRACT must be on or off", false]);
  });
});

// The message a refused setting gives; the value is never in it.
const refusal = (settings: Record<string, string>): string => {
  try {
    loadPrepConfig(settings);
  } catch (e) {
    if (e instanceof FunnelConfigError) return e.message;
    throw e;
  }
  throw new Error("not refused");
};

describe("loadPrepConfig (NS-241 slice 5)", () => {
  it("takes PREP_TIME_ZONE, else ALERT_TIME_ZONE, with 9 to 5 by default", () => {
    expect([
      loadPrepConfig({ PREP_TIME_ZONE: "Europe/Berlin", ALERT_TIME_ZONE: "UTC" }),
      loadPrepConfig({ ALERT_TIME_ZONE: "UTC" }),
    ]).toEqual([
      { timeZone: "Europe/Berlin", workingHours: { start: 540, end: 1020 } },
      { timeZone: "UTC", workingHours: { start: 540, end: 1020 } },
    ]);
  });

  it("reads PREP_WORKING_HOURS as HH:MM-HH:MM in minutes after midnight", () => {
    expect(loadPrepConfig({ PREP_TIME_ZONE: "UTC", PREP_WORKING_HOURS: "08:30-18:00" })).toEqual({
      timeZone: "UTC",
      workingHours: { start: 510, end: 1080 },
    });
  });

  it("refuses a missing or unknown zone and bad hours by the setting's name only", () => {
    expect([
      refusal({}),
      refusal({ PREP_TIME_ZONE: "Mars/Olympus_Mons" }),
      refusal({ ALERT_TIME_ZONE: "Mars/Olympus_Mons" }),
      refusal({ PREP_TIME_ZONE: "UTC", PREP_WORKING_HOURS: "17:00-09:00" }),
      refusal({ PREP_TIME_ZONE: "UTC", PREP_WORKING_HOURS: "nine to five" }),
    ]).toEqual([
      "PREP_TIME_ZONE (or ALERT_TIME_ZONE) must name your time zone",
      "PREP_TIME_ZONE is not a known IANA time zone",
      "ALERT_TIME_ZONE is not a known IANA time zone",
      "PREP_WORKING_HOURS must be HH:MM-HH:MM, start before end",
      "PREP_WORKING_HOURS must be HH:MM-HH:MM, start before end",
    ]);
  });
});
