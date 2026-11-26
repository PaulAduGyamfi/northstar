import { describe, expect, it } from "vitest";
import { keyWords, MetricsBody, medianText, rateText } from "./metrics";

// The metrics page's words (NS-208). Synthetic numbers only.

describe("rateText", () => {
  it("shows the rate, its count and its interval when there is enough data", () => {
    expect(rateText({ k: 8, n: 20, enough: true, rate: 0.4, low: 0.219, high: 0.613 })).toBe(
      "40% (8 of 20; 22–61%)",
    );
  });

  it("says not enough data yet below the minimum, never a percentage", () => {
    expect(rateText({ k: 3, n: 5, enough: false, rate: null, low: null, high: null })).toBe(
      "not enough data yet (3 of 5)",
    );
  });
});

describe("medianText and keyWords", () => {
  it("words a median and a group key", () => {
    expect([
      medianText({ days: 2.5, n: 12 }),
      medianText({ days: 1, n: 1 }),
      medianText({ days: null, n: 0 }),
      keyWords("under_1d"),
      keyWords("greenhouse"),
    ]).toEqual([
      "2.5 days (from 12)",
      "1 day (from 1)",
      "no data yet",
      "Applied within a day of posting",
      "greenhouse",
    ]);
  });
});

describe("MetricsBody", () => {
  it("refuses an answer that isn't the API's shape", () => {
    expect(MetricsBody.safeParse({ funnel: "nope" }).success).toBe(false);
  });
});
