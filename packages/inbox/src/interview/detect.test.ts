import { describe, expect, it } from "vitest";
import {
  type CalendarEvent,
  detectInterview,
  type InterviewCandidate,
  interviewFormat,
  interviewFromMail,
  ownDomains,
} from "./detect.js";

// Synthetic events, people and companies only (the repo is public).
const T = (iso: string) => new Date(iso);
const INITECH: InterviewCandidate = {
  applicationId: "app-initech",
  companyDomains: ["initech.example"],
  activeFrom: T("2026-11-01T00:00:00Z"),
  activeUntil: null,
};
const GLOBEX: InterviewCandidate = {
  applicationId: "app-globex",
  companyDomains: ["globex.example"],
  activeFrom: T("2026-11-01T00:00:00Z"),
  activeUntil: null,
};

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "evt-1",
  title: "Technical interview: Paul / Initech",
  description: null,
  start: T("2026-12-02T15:00:00Z"),
  end: T("2026-12-02T16:00:00Z"),
  status: "confirmed",
  organizer: "recruiting@initech.example",
  attendees: ["dana@initech.example", "paul@example.com", "sam@initech.example"],
  ...over,
});

describe("detectInterview", () => {
  it("links an interview from the company's domain, with its format and interviewers", () => {
    expect(detectInterview(event(), [INITECH, GLOBEX])).toEqual({
      kind: "interview",
      applicationId: "app-initech",
      format: "technical",
      start: T("2026-12-02T15:00:00Z"),
      end: T("2026-12-02T16:00:00Z"),
      interviewers: ["dana@initech.example", "sam@initech.example"],
      confirmed: false,
    });
  });

  it("finds nothing in a cancelled event, a lunch, or an unknown company", () => {
    expect([
      detectInterview(event({ status: "cancelled" }), [INITECH]),
      detectInterview(event({ title: "Lunch with Dana" }), [INITECH]),
      detectInterview(event({ organizer: "hr@hooli.example", attendees: [] }), [INITECH]),
    ]).toEqual([
      { kind: "none", reason: "cancelled" },
      { kind: "none", reason: "not_interview" },
      { kind: "none", reason: "no_match" },
    ]);
  });

  it("reads only the title, so a lunch that mentions an interview in its notes isn't one", () => {
    const lunch = event({ title: "Team lunch", description: "Before your interview next week" });
    expect(detectInterview(lunch, [INITECH])).toEqual({ kind: "none", reason: "not_interview" });
  });

  it("calls two applications at the same company ambiguous", () => {
    const second = { ...INITECH, applicationId: "app-initech-2" };
    expect(detectInterview(event(), [INITECH, second])).toEqual({
      kind: "ambiguous",
      candidateIds: ["app-initech", "app-initech-2"],
    });
  });

  it("never counts a shared ATS or freemail domain as the company's own", () => {
    const mixed = {
      ...INITECH,
      companyDomains: ["greenhouse.io", "boards.greenhouse.io", "gmail.com", "Initech.example"],
    };
    expect(ownDomains(mixed)).toEqual(["initech.example"]);
  });

  it("ignores an application whose active window doesn't hold the event", () => {
    const closed = { ...INITECH, activeUntil: T("2026-11-20T00:00:00Z") };
    expect(detectInterview(event(), [closed])).toEqual({ kind: "none", reason: "no_match" });
  });

  it("matches a subdomain of the company's domain", () => {
    const sub = event({ organizer: "talent@careers.initech.example", attendees: [] });
    expect(detectInterview(sub, [INITECH])).toMatchObject({ applicationId: "app-initech" });
  });
});

describe("interviewFormat", () => {
  it("maps each format's words, the most specific first", () => {
    expect(
      [
        "System design interview",
        "Behavioural interview",
        "Coding interview",
        "Onsite: final round",
        "Phone screen with Dana",
        "Intro call",
        "Interview",
        "Technical system design round",
      ].map(interviewFormat),
    ).toEqual([
      "system_design",
      "behavioral",
      "technical",
      "onsite",
      "phone_screen",
      "phone_screen",
      "other",
      "system_design",
    ]);
  });
});

describe("interviewFromMail", () => {
  const linked = { kind: "linked" as const, applicationId: "app-initech" };

  it("puts an interview to schedule on a linked interview request or scheduling mail", () => {
    expect([
      interviewFromMail("interview_request", linked),
      interviewFromMail("scheduling", linked),
    ]).toEqual([
      { kind: "to_schedule", applicationId: "app-initech" },
      { kind: "to_schedule", applicationId: "app-initech" },
    ]);
  });

  it("does nothing for a queued link or another kind of mail", () => {
    expect([
      interviewFromMail("interview_request", { kind: "queued" }),
      interviewFromMail("rejection", linked),
    ]).toEqual([{ kind: "none" }, { kind: "none" }]);
  });
});
