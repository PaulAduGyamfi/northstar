import { describe, expect, it } from "vitest";
import { FunnelConfigError, loadFunnelConfig } from "./config.js";

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
