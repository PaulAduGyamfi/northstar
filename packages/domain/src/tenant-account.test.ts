import { describe, expect, it } from "vitest";
import { ACCOUNT_STATUSES, type AccountStatus, nextAccountStatus } from "./tenant-account.js";

// The employer-account state machine (NS-124, ACC-001), checked over every pair of statuses.
const ALLOWED: ReadonlyArray<[AccountStatus, AccountStatus]> = [
  ["none", "creating"],
  ["creating", "verifying"],
  ["creating", "active"],
  ["creating", "needs_human"],
  ["verifying", "active"],
  ["verifying", "needs_human"],
  ["active", "locked"],
  ["active", "needs_human"],
  ["locked", "active"],
  ["locked", "needs_human"],
  ["needs_human", "active"],
  ["needs_human", "none"],
];

describe("nextAccountStatus", () => {
  it("allows exactly the moves in the spec and refuses every other pair", () => {
    const allowed: string[] = [];
    for (const from of ACCOUNT_STATUSES) {
      for (const to of ACCOUNT_STATUSES) {
        if (nextAccountStatus(from, to).ok) allowed.push(`${from}>${to}`);
      }
    }
    expect(allowed.sort()).toEqual(ALLOWED.map(([f, t]) => `${f}>${t}`).sort());
  });

  it("names both statuses when it refuses a move", () => {
    expect(nextAccountStatus("none", "active")).toEqual({
      ok: false,
      error: { kind: "IllegalAccountMove", from: "none", to: "active" },
    });
  });
});
