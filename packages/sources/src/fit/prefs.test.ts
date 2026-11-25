import { PREFERENCE_DEFAULTS } from "@northstar/db";
import { describe, expect, it } from "vitest";
import { applyPreference, showPreference } from "./prefs.js";

const D = PREFERENCE_DEFAULTS;

describe("applyPreference (SRC-017)", () => {
  it("sets a list from comma-separated items, trimmed and without repeats", () => {
    const r = applyPreference(
      D,
      "titles",
      " Backend Engineer, Platform Engineer ,backend engineer",
    );
    expect(r.ok && r.value.titles).toEqual(["Backend Engineer", "Platform Engineer"]);
  });

  it("clears a list with -", () => {
    const r = applyPreference({ ...D, locations: ["Austin"] }, "locations", "-");
    expect(r.ok && r.value.locations).toEqual([]);
  });

  it("accepts remote kinds in any case", () => {
    const r = applyPreference(D, "remote", "Remote, hybrid");
    expect(r.ok && r.value.remote).toEqual(["remote", "hybrid"]);
  });

  it("refuses a remote kind that doesn't exist", () => {
    expect(applyPreference(D, "remote", "anywhere")).toEqual({
      ok: false,
      error: {
        kind: "BadValue",
        field: "remote",
        why: "onsite, hybrid or remote, comma-separated",
      },
    });
  });

  it("sets the comp floor as a whole number", () => {
    const r = applyPreference(D, "compFloor", "150000");
    expect(r.ok && r.value.compFloor).toBe(150_000);
  });

  it("refuses a comp floor written with a currency sign", () => {
    expect(applyPreference(D, "compFloor", "$150k").ok).toBe(false);
  });

  it("refuses a comp floor above the comp target", () => {
    const r = applyPreference({ ...D, compTarget: 120_000 }, "compFloor", "150000");
    expect(r).toEqual({
      ok: false,
      error: { kind: "BadValue", field: "compFloor", why: "compFloor can't be above compTarget" },
    });
  });

  it("clears the comp floor with -", () => {
    const r = applyPreference({ ...D, compFloor: 150_000 }, "compFloor", "-");
    expect(r.ok && r.value.compFloor).toBeNull();
  });

  it("upper-cases a currency code", () => {
    const r = applyPreference(D, "currency", "eur");
    expect(r.ok && r.value.currency).toBe("EUR");
  });

  it("refuses a suggest threshold above the queue threshold", () => {
    expect(applyPreference(D, "suggestAt", "85").ok).toBe(false);
  });

  it("refuses a threshold above 100", () => {
    expect(applyPreference(D, "queueAt", "101").ok).toBe(false);
  });

  it("refuses a field that doesn't exist", () => {
    expect(applyPreference(D, "salary", "1")).toEqual({
      ok: false,
      error: { kind: "UnknownField", field: "salary" },
    });
  });

  it("refuses an empty value", () => {
    expect(applyPreference(D, "titles", "  ").ok).toBe(false);
  });

  it("refuses a list item longer than 100 characters", () => {
    expect(applyPreference(D, "dealbreakers", "x".repeat(101)).ok).toBe(false);
  });
});

describe("showPreference", () => {
  it("shows an empty list or a missing number as -", () => {
    expect([showPreference(D, "titles"), showPreference(D, "compFloor")]).toEqual(["-", "-"]);
  });

  it("shows a list comma-separated", () => {
    expect(showPreference({ ...D, remote: ["remote", "hybrid"] }, "remote")).toBe("remote, hybrid");
  });
});
