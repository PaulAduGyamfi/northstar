import { describe, expect, it } from "vitest";
import { jobMatchRoute } from "./fit/model-match.js";
import { jobExtractRoute } from "./job-extract-route.js";

// Route priorities for the LLM spend cap (NS-176, ADR-0021).
describe("sources' routes", () => {
  it("are fresh: on the path from a new posting to Paul's queue", () => {
    expect([jobExtractRoute().priority, jobMatchRoute().priority]).toEqual(["fresh", "fresh"]);
  });
});
