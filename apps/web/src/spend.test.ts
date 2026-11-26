import { describe, expect, it } from "vitest";
import { spendView } from "./spend";

// Model spend on Health (NS-219): the words for usage and for each paused priority.

const body = {
  todayUsd: 4.2,
  monthUsd: 31.5,
  dailyCapUsd: 5,
  monthlyCapUsd: 100,
  paused: [] as { priority: "low" | "normal" | "fresh"; cap: "daily" | "monthly" }[],
};

describe("spendView", () => {
  it("shows today's and this month's spend against each cap, and nothing paused", () => {
    expect(spendView(body)).toEqual({
      usage: [
        "Today: $4.20 of the $5.00 daily cap",
        "This month: $31.50 of the $100.00 monthly cap",
      ],
      paused: [],
      summary: "Nothing is paused.",
    });
  });

  it("says when there is no cap", () => {
    expect(spendView({ ...body, dailyCapUsd: null, monthlyCapUsd: null }).usage).toEqual([
      "Today: $4.20 (no daily cap)",
      "This month: $31.50 (no monthly cap)",
    ]);
  });

  it("names each paused kind of work, the cap and share that holds it, and when it resumes", () => {
    expect(
      spendView({
        ...body,
        paused: [
          { priority: "low", cap: "daily" },
          { priority: "normal", cap: "daily" },
          { priority: "fresh", cap: "monthly" },
        ],
      }),
    ).toEqual({
      usage: [
        "Today: $4.20 of the $5.00 daily cap",
        "This month: $31.50 of the $100.00 monthly cap",
      ],
      paused: [
        "Paused: sorting job mail. Today's spend reached 80% of the daily cap. It starts again tomorrow (UTC), or sooner if you raise the cap.",
        "Paused: drafting and other model work. Today's spend reached the daily cap. It starts again tomorrow (UTC), or sooner if you raise the cap.",
        "Paused: reading new postings, matching jobs and verification emails. This month's spend reached 125% of the monthly cap. It starts again next month (UTC), or sooner if you raise the cap.",
      ],
      summary: "Some model work is paused by the spend cap.",
    });
  });
});
