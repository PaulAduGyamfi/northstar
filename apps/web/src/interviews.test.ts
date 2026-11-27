import { describe, expect, it } from "vitest";
import {
  decidedMessage,
  decideProblem,
  type InterviewItem,
  InterviewsBody,
  interviewRow,
  waitingFirst,
} from "./interviews";

// The interview confirm page's words (NS-240 slice 5). Synthetic jobs and companies only.

const ITEM: InterviewItem = {
  detectionId: "7a1e2a10-6b2c-4f0e-8a51-7c2b9d0e1f01",
  applicationId: "3f0c7a52-1d4e-4c8b-9a61-2b7e5d9c0a11",
  format: "technical",
  start: "2026-12-02T15:00:00.000Z",
  end: "2026-12-02T16:00:00.000Z",
  interviewerCount: 2,
  decision: null,
  jobTitle: "Platform Engineer",
  company: "Initech",
};

describe("interviewRow", () => {
  it("says what, for which job, when and who, and that it isn't verified yet", () => {
    expect(interviewRow(ITEM, "UTC")).toEqual({
      what: "Technical interview with Initech (Platform Engineer)",
      when: "Wed, Dec 2, 3:00 PM to 4:00 PM",
      who: "2 interviewers from the company",
      status: "Not verified: confirm or dismiss",
    });
  });

  it("names an unknown job plainly, and counts one interviewer or none", () => {
    const one = interviewRow(
      { ...ITEM, company: null, jobTitle: null, interviewerCount: 1 },
      "UTC",
    );
    const none = interviewRow({ ...ITEM, format: "other", interviewerCount: 0 }, "UTC");
    expect([one.what, one.who, none.what, none.who]).toEqual([
      "Technical interview with a job you applied to",
      "1 interviewer from the company",
      "Interview with Initech (Platform Engineer)",
      "No interviewers from the company listed",
    ]);
  });

  it("shows a decision in words", () => {
    expect([
      interviewRow({ ...ITEM, decision: "confirmed" }, "UTC").status,
      interviewRow({ ...ITEM, decision: "dismissed" }, "UTC").status,
    ]).toEqual(["Confirmed", "Dismissed"]);
  });
});

describe("after a choice", () => {
  it("says a confirm doesn't move the application, and a dismiss won't ask again", () => {
    expect([decidedMessage("confirmed"), decidedMessage("dismissed")]).toEqual([
      "Confirmed. The application's status doesn't change: you move it yourself when you're ready.",
      "Dismissed. Northstar won't ask about this invite again.",
    ]);
  });

  it("names each refusal, and anything else plainly", () => {
    expect(["already_decided", "superseded", "not_found", "nope"].map(decideProblem)).toEqual([
      "You already decided this one.",
      "This interview moved. Decide on the new time below.",
      "That interview isn't there anymore.",
      "That didn't work. Try again.",
    ]);
  });
});

describe("waitingFirst", () => {
  it("splits waiting detections from decided ones, keeping their order", () => {
    const later = { ...ITEM, detectionId: "b", start: "2026-12-05T15:00:00.000Z" };
    const done = { ...ITEM, detectionId: "c", decision: "confirmed" as const };
    expect(waitingFirst([ITEM, done, later])).toEqual({ waiting: [ITEM, later], decided: [done] });
  });
});

describe("InterviewsBody", () => {
  it("refuses a format or decision the API never sends", () => {
    expect([
      InterviewsBody.safeParse({ items: [{ ...ITEM, format: "lunch" }] }).success,
      InterviewsBody.safeParse({ items: [{ ...ITEM, decision: "submitted" }] }).success,
      InterviewsBody.safeParse({ items: [ITEM] }).success,
    ]).toEqual([false, false, true]);
  });
});
