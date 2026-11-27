import { describe, expect, it } from "vitest";
import {
  type AlertSettings,
  alertRows,
  changeBody,
  quietValue,
  saveWords,
} from "./search-settings";

// Settings → Search (NS-199 slice 3): the alert settings in words and the bodies the page sends.

const settings: AlertSettings = {
  quiet: "22:00-07:00",
  timeZone: "America/New_York",
  tier1InQuietHours: true,
  sources: { quiet: "default", timeZone: "stored", tier1: "default" },
  unknownStoredZone: false,
};

describe("alertRows", () => {
  it("words each setting and says whether it is set here or the default", () => {
    expect(alertRows(settings)).toEqual([
      { field: "quiet", label: "Quiet hours", value: "22:00 to 07:00", source: "default" },
      { field: "zone", label: "Time zone", value: "America/New_York", source: "set here" },
      {
        field: "tier1",
        label: "Tier-1 boards alert in quiet hours",
        value: "yes",
        source: "default",
      },
    ]);
  });

  it("says quiet hours are off, and when a stored zone isn't known here", () => {
    const rows = alertRows({ ...settings, quiet: "off", unknownStoredZone: true });
    expect(rows[0]?.value).toBe("off");
    expect(rows[1]?.source).toContain("isn't known");
  });
});

describe("quietValue", () => {
  it("sends off, or two different times as a range", () => {
    expect(quietValue(true, "", "")).toBe("off");
    expect(quietValue(false, "23:00", "06:30")).toBe("23:00-06:30");
  });

  it("sends nothing for equal or missing times", () => {
    expect(quietValue(false, "07:00", "07:00")).toBeNull();
    expect(quietValue(false, "", "06:30")).toBeNull();
  });
});

describe("changeBody and saveWords", () => {
  it("names the setting and its value, or null to use the default", () => {
    expect(changeBody("tier1", "false")).toBe('{"field":"tier1","value":"false"}');
    expect(changeBody("zone", null)).toBe('{"field":"zone","value":null}');
  });

  it("says what the API answered", () => {
    expect(saveWords(200, true)).toBe("Saved. The next alert pass uses it.");
    expect(saveWords(200, false)).toBe("Already set.");
    expect(saveWords(400, null)).toContain("didn't accept");
    expect(saveWords(503, null)).toBe("Not saved. Try again in a moment.");
  });
});
