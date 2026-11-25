import { describe, expect, it } from "vitest";
import { CONSENT_POLICIES, decideConsent, NOTICE_KINDS } from "./consent.js";

// The consent policy (NS-124, ACC-008): marketing is always declined; the rest follows Paul's one
// setting.
describe("decideConsent", () => {
  it("declines every marketing opt-in, whatever the policy", () => {
    expect(CONSENT_POLICIES.map((p) => decideConsent(p, "marketing"))).toEqual([
      "decline",
      "decline",
    ]);
  });

  it("accepts standard terms and privacy notices under the auto policy", () => {
    expect([decideConsent("auto", "terms"), decideConsent("auto", "privacy")]).toEqual([
      "accept",
      "accept",
    ]);
  });

  it("asks Paul about every non-marketing notice under ask_per_tenant", () => {
    expect(
      NOTICE_KINDS.filter((k) => k !== "marketing").map((k) => decideConsent("ask_per_tenant", k)),
    ).toEqual(["ask", "ask"]);
  });
});
