import { describe, expect, it } from "vitest";
import type { CalendarEvent, InterviewCandidate } from "./detect.js";
import {
  DETECTION_WINDOW_DAYS,
  type DetectionLetter,
  type DetectionRecordResult,
  type DetectionRunDeps,
  runInterviewDetection,
  type StoredDetection,
} from "./run.js";

// The detection run (NS-240 slice 4) on fakes: no calendar, database or network. Synthetic
// events, people and companies only (the repo is public).

const T = (iso: string) => new Date(iso);
const NOW = T("2026-11-27T06:00:00Z");
const APP = "3f0c7a52-1d4e-4c8b-9a61-2b7e5d9c0a11";
const OTHER = "8a2e4b10-5c6d-4e7f-8a90-1b2c3d4e5f60";
const CANDIDATE = "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f";

const INITECH: InterviewCandidate = {
  applicationId: APP,
  companyDomains: ["initech.example"],
  activeFrom: T("2026-11-01T00:00:00Z"),
  activeUntil: null,
};

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "evt1",
  title: "Technical interview: Paul / Initech",
  description: null,
  start: T("2026-12-02T15:00:00Z"),
  end: T("2026-12-02T16:00:00Z"),
  status: "confirmed",
  organizer: "recruiting@initech.example",
  attendees: ["dana@initech.example", "paul@example.com", "sam@initech.example"],
  ...over,
});

// A fake run: records what it was asked to store and which letters it wrote.
function fakeRun(opts: {
  events?: CalendarEvent[];
  candidates?: InterviewCandidate[];
  answer?: (d: StoredDetection) => DetectionRecordResult;
  listFails?: boolean;
  recordFails?: boolean;
  letterFails?: boolean;
}) {
  const stored: StoredDetection[] = [];
  const letters: DetectionLetter[] = [];
  const windows: { timeMin: Date; timeMax: Date }[] = [];
  const deps: DetectionRunDeps = {
    calendar: {
      listEvents: async (w) => {
        windows.push(w);
        if (opts.listFails) throw new Error("calendar down");
        return opts.events ?? [event()];
      },
    },
    candidateId: CANDIDATE,
    candidates: async () => opts.candidates ?? [INITECH],
    record: async (d) => {
      if (opts.recordFails) throw new Error("db down");
      stored.push(d);
      return opts.answer?.(d) ?? { ok: true, recorded: true };
    },
    deadLetter: async (l) => {
      if (opts.letterFails) throw new Error("db down");
      letters.push(l);
    },
    now: () => NOW,
  };
  return { deps, stored, letters, windows };
}

describe("runInterviewDetection", () => {
  it("stores an interview from the company's domain with ids, format, times and a count only", async () => {
    const run = fakeRun({});
    const report = await runInterviewDetection(run.deps);
    expect(run.stored).toEqual([
      {
        applicationId: APP,
        calendarEventId: "evt1",
        format: "technical",
        start: T("2026-12-02T15:00:00Z"),
        end: T("2026-12-02T16:00:00Z"),
        interviewerCount: 2,
      },
    ]);
    expect([report.events, report.interviews, report.recorded, report.stoppedBy]).toEqual([
      1,
      1,
      1,
      null,
    ]);
  });

  it("reads one window from now to the detection window's end", async () => {
    const run = fakeRun({ events: [] });
    await runInterviewDetection(run.deps);
    expect(run.windows).toEqual([
      {
        timeMin: NOW,
        timeMax: new Date(NOW.getTime() + DETECTION_WINDOW_DAYS * 24 * 60 * 60 * 1000),
      },
    ]);
  });

  it("stores nothing for cancelled, non-interview, unmatched or ambiguous events, and counts each", async () => {
    const run = fakeRun({
      events: [
        event({ id: "a", status: "cancelled" }),
        event({ id: "b", title: "Lunch with Initech friends" }),
        event({ id: "c", organizer: "hr@globex.example", attendees: ["x@globex.example"] }),
        event({ id: "d" }),
      ],
      candidates: [INITECH, { ...INITECH, applicationId: OTHER }],
    });
    const report = await runInterviewDetection(run.deps);
    expect(run.stored).toEqual([]);
    expect([report.cancelled, report.notInterview, report.noMatch, report.ambiguous]).toEqual([
      1, 1, 1, 1,
    ]);
  });

  it("matches nothing while applications carry no company domains", async () => {
    const run = fakeRun({ candidates: [{ ...INITECH, companyDomains: [] }] });
    const report = await runInterviewDetection(run.deps);
    expect([run.stored, report.noMatch]).toEqual([[], 1]);
  });

  it("counts an unchanged detection apart from a new one", async () => {
    const run = fakeRun({ answer: () => ({ ok: true, recorded: false }) });
    const report = await runInterviewDetection(run.deps);
    expect([report.recorded, report.unchanged]).toEqual([0, 1]);
  });

  it("turns too many changes into one dead letter per event and application, keyed without the event id", async () => {
    const run = fakeRun({ answer: () => ({ ok: false, kind: "TooManyChanges" }) });
    await runInterviewDetection(run.deps);
    await runInterviewDetection(run.deps);
    const [first, second] = run.letters;
    expect(first).toEqual({
      kind: "calendar.interview_detection",
      reasonCode: "too_many_changes",
      subject: `application:${APP}`,
      idempotencyKey: expect.stringMatching(
        new RegExp(`^interview_detection:${APP}:[0-9a-f]{32}$`),
      ),
    });
    // The same key both runs, so the store keeps one letter.
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(first?.idempotencyKey.includes("evt1")).toBe(false);
  });

  it("writes one daily-limit letter for the day and stops storing for the rest of the run", async () => {
    const run = fakeRun({
      events: [event({ id: "a" }), event({ id: "b" }), event({ id: "c" })],
      answer: () => ({ ok: false, kind: "DailyLimit" }),
    });
    const report = await runInterviewDetection(run.deps);
    expect(run.letters).toEqual([
      {
        kind: "calendar.interview_detection",
        reasonCode: "daily_limit",
        subject: `candidate:${CANDIDATE}`,
        idempotencyKey: "interview_detection:daily_limit:2026-11-27",
      },
    ]);
    expect([run.stored.length, report.interviews, report.dailyLimit]).toEqual([1, 3, 1]);
  });

  it("skips a refused invalid detection or unknown application without a letter", async () => {
    const answers: DetectionRecordResult[] = [
      { ok: false, kind: "InvalidDetection" },
      { ok: false, kind: "UnknownApplication" },
    ];
    const run = fakeRun({
      events: [event({ id: "a" }), event({ id: "b" })],
      answer: () => answers.shift() ?? { ok: true, recorded: true },
    });
    const report = await runInterviewDetection(run.deps);
    expect([report.skipped, run.letters]).toEqual([2, []]);
  });

  it("stores nothing and says so when the calendar read fails", async () => {
    const run = fakeRun({ listFails: true });
    const report = await runInterviewDetection(run.deps);
    expect([run.stored, report.stoppedBy]).toEqual([[], "read"]);
  });

  it("stops at a failed store call, and at a dead letter it couldn't write", async () => {
    const failedStore = await runInterviewDetection(fakeRun({ recordFails: true }).deps);
    const failedLetter = await runInterviewDetection(
      fakeRun({ letterFails: true, answer: () => ({ ok: false, kind: "TooManyChanges" }) }).deps,
    );
    expect([failedStore.stoppedBy, failedLetter.stoppedBy]).toEqual(["record", "dead_letter"]);
  });
});
