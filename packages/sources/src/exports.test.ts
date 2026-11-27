import { describe, expect, it } from "vitest";
import { ageHours, freshness, queueScore, roleFamily } from "./index.js";

// The package entry exports what the API's jobs page (NS-130 slice 10) uses, unchanged.
describe("the jobs page's exports", () => {
  it("gives the queue's order and the directions' role grouping from the package entry", () => {
    const now = new Date("2026-11-27T12:00:00Z");
    const twoDays = ageHours(new Date("2026-11-25T12:00:00Z"), now, now);
    expect([
      twoDays,
      freshness(twoDays),
      queueScore(freshness(0), 0.8),
      roleFamily("Senior Backend Engineer, Payments"),
    ]).toEqual([48, 0.25, 0.8, "backend engineer"]);
  });
});
