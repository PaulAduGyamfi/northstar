import { describe, expect, it } from "vitest";
import { isStartedBy, isSubmittedVia, originBucket } from "./origin.js";

// Application origin (INB-007, INB-010).

describe("originBucket", () => {
  it("counts an application as Northstar's only when it wasn't submitted by hand", () => {
    expect([
      originBucket("northstar", "auto"),
      originBucket("northstar", "approved"),
      originBucket("northstar", null),
      originBucket("northstar", "by_hand"),
      originBucket("outside", "by_hand"),
      originBucket("recruiter_inbound", "approved"),
      originBucket(null, "auto"),
    ]).toEqual([
      "northstar",
      "northstar",
      "northstar",
      "northstar_by_hand",
      "outside",
      "recruiter_inbound",
      "unknown",
    ]);
  });
});

describe("isStartedBy and isSubmittedVia", () => {
  it("accept only the known values", () => {
    expect([
      isStartedBy("outside"),
      isStartedBy("paul"),
      isSubmittedVia("handoff"),
      isSubmittedVia(1),
    ]).toEqual([true, false, true, false]);
  });
});
