import type { DetectionRunReport } from "@northstar/inbox";
import { CalendarError, OAuthError } from "@northstar/inbox";
import { describe, expect, it } from "vitest";
import { type InterviewsRun, interviewsCommand, toInterviewCandidates } from "./interviews.js";

// `funnel interviews` (NS-240 slice 6) with the run faked: no Google, calendar or database.
// Invented ids and domains only.

const REPORT: DetectionRunReport = {
  events: 12,
  interviews: 3,
  recorded: 2,
  unchanged: 1,
  ambiguous: 1,
  cancelled: 1,
  notInterview: 6,
  noMatch: 1,
  tooManyChanges: 0,
  dailyLimit: 0,
  skipped: 0,
  stoppedBy: null,
};

async function run(result: InterviewsRun | Error) {
  const printed: string[] = [];
  const code = await interviewsCommand({
    print: (l) => printed.push(l),
    runInterviews: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  });
  return { code, printed };
}

const ok = (over: Partial<DetectionRunReport> = {}): InterviewsRun => ({
  report: { ...REPORT, ...over },
  applications: 4,
  withDomains: 2,
});

describe("interviewsCommand", () => {
  it("prints the counts of a finished run and points to the confirm page", async () => {
    expect(await run(ok())).toEqual({
      code: 0,
      printed: [
        "Read 12 calendar event(s) in the next 30 days. Interviews found: 3 (2 new, 1 unchanged).",
        "Not matched: 1. Matched more than one application: 1. Not an interview: 6. Cancelled: 1.",
        "Confirm or dismiss them on /interviews.",
      ],
    });
  });

  it("doesn't point to the confirm page when nothing new was found", async () => {
    const { printed } = await run(ok({ recorded: 0, unchanged: 3 }));
    expect(printed.some((l) => l.includes("/interviews"))).toBe(false);
  });

  it("counts refused interviews and says where they wait", async () => {
    const { printed } = await run(ok({ tooManyChanges: 1, dailyLimit: 1, skipped: 1 }));
    expect(printed).toContain(
      "Not saved: 3 (moved too often 1, daily limit 1, other 1). Each is in Stuck work on /health.",
    );
  });

  it("says where a stopped run stopped and exits 1", async () => {
    const { code, printed } = await run(ok({ stoppedBy: "record", recorded: 1 }));
    expect([code, printed.at(-1)]).toEqual([
      1,
      "Stopped early: saving an interview failed. What was saved stays; run it again later.",
    ]);
  });

  it("hints at jobs domains when no open application has a company domain", async () => {
    const { printed } = await run({ ...ok(), withDomains: 0 });
    expect(printed[0]).toBe(
      "None of your 4 open application(s) has a company mail domain, so no invite can match. Add them with `jobs domains add <company-id> <domain>`.",
    );
  });

  it("prints a consent or Calendar error's own fixed message", async () => {
    const consent = await run(new OAuthError("consent timed out"));
    const calendar = await run(new CalendarError("Calendar answered 503", 503));
    expect([consent.code, consent.printed[0], calendar.printed[0]]).toEqual([
      1,
      "Interview detection stopped: consent timed out",
      "Interview detection stopped: Calendar answered 503",
    ]);
  });

  it("prints only the name of any other error, never its message", async () => {
    const error = new TypeError("row quoted here: test-key");
    const { printed } = await run(error);
    expect(printed[0]).toBe("Interview detection stopped: TypeError");
  });
});

describe("toInterviewCandidates", () => {
  it("makes each open application active from its creation, with no end", () => {
    const createdAt = new Date("2026-11-01T10:00:00Z");
    expect(
      toInterviewCandidates([
        {
          applicationId: "a1",
          createdAt,
          ats: ["greenhouse"],
          companyDomains: ["initech.example"],
        },
        { applicationId: "a2", createdAt, ats: [] },
      ]),
    ).toEqual([
      {
        applicationId: "a1",
        companyDomains: ["initech.example"],
        activeFrom: createdAt,
        activeUntil: null,
      },
      { applicationId: "a2", companyDomains: [], activeFrom: createdAt, activeUntil: null },
    ]);
  });
});
