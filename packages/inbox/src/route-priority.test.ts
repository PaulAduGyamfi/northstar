import { describe, expect, it } from "vitest";
import { mailClassifyRoute } from "./mail-classify-route.js";
import { verificationExtractRoute } from "./verify/model-pick.js";

// Route priorities for the LLM spend cap (NS-176, ADR-0021).
describe("inbox's routes", () => {
  it("are fresh for a verification code and low for the bulk mail backfill", () => {
    expect([verificationExtractRoute().priority, mailClassifyRoute().priority]).toEqual([
      "fresh",
      "low",
    ]);
  });
});
