import { createHash } from "node:crypto";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { CalendarClient } from "../calendar/client.js";
import { detectInterview, type InterviewCandidate, type InterviewFormat } from "./detect.js";

// The interview detection run (NS-240 slice 4, CAL-002): read one window of calendar events,
// detect interviews against the open applications and store each one through a port
// (recordInterviewDetection in @northstar/db). Plain code with ports, no caller yet (the worker
// process, #230). Detections are proposals for Paul (invites aren't authenticated); nothing here
// moves a status. Ids, a format, times and a count cross the ports: never a title, address or name.

// How far ahead one run looks. The client refuses a window over 60 days.
export const DETECTION_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// The dead-letter kind for refusals the store can't take (DEAD_LETTER_KINDS in @northstar/db).
export const DETECTION_DEAD_LETTER_KIND = "calendar.interview_detection";

// What the run stores for one interview: ids, format, times and a count only.
export type StoredDetection = {
  applicationId: string;
  calendarEventId: string;
  format: InterviewFormat;
  start: Date;
  end: Date;
  interviewerCount: number;
};

// The store's answer, as recordInterviewDetection gives it.
export type DetectionRecordResult =
  | { ok: true; recorded: boolean }
  | {
      ok: false;
      kind: "InvalidDetection" | "UnknownApplication" | "TooManyChanges" | "DailyLimit";
    };

export type DetectionLetter = {
  kind: typeof DETECTION_DEAD_LETTER_KIND;
  reasonCode: "too_many_changes" | "daily_limit";
  // `application:<id>` or `candidate:<id>`: the dead-letter subject pattern takes a uuid only.
  subject: string;
  idempotencyKey: string;
};

export type DetectionRunDeps = {
  calendar: Pick<CalendarClient, "listEvents">;
  candidateId: string;
  // Open applications with their company domains. None are stored yet (#313).
  candidates: () => Promise<readonly InterviewCandidate[]>;
  record: (detection: StoredDetection) => Promise<DetectionRecordResult>;
  deadLetter: (letter: DetectionLetter) => Promise<void>;
  now: () => Date;
};

export type DetectionRunReport = {
  events: number;
  interviews: number;
  recorded: number;
  unchanged: number;
  ambiguous: number;
  cancelled: number;
  notInterview: number;
  noMatch: number;
  tooManyChanges: number;
  dailyLimit: number;
  // Refused as invalid or not this candidate's application: a bug or a stale candidate list.
  skipped: number;
  // Where a failure stopped the run, or null when it finished. In the report and span only.
  stoppedBy: null | "read" | "record" | "dead_letter";
};

// A short, stable stand-in for an event id in a dead-letter key: the key pattern is lowercase
// ids only, and an event id may carry upper case.
const eventKey = (eventId: string): string =>
  createHash("sha256").update(eventId).digest("hex").slice(0, 32);

const tracer = trace.getTracer("@northstar/inbox");

export function runInterviewDetection(deps: DetectionRunDeps): Promise<DetectionRunReport> {
  return tracer.startActiveSpan("calendar.detect", async (span) => {
    const report: DetectionRunReport = {
      events: 0,
      interviews: 0,
      recorded: 0,
      unchanged: 0,
      ambiguous: 0,
      cancelled: 0,
      notInterview: 0,
      noMatch: 0,
      tooManyChanges: 0,
      dailyLimit: 0,
      skipped: 0,
      stoppedBy: null,
    };
    try {
      await detect(deps, report);
    } finally {
      for (const [key, value] of Object.entries(report)) {
        if (typeof value === "number") span.setAttribute(`northstar.calendar_detect.${key}`, value);
      }
      if (report.stoppedBy !== null) {
        span.setAttribute("northstar.calendar_detect.stopped_by", report.stoppedBy);
        span.setStatus({ code: SpanStatusCode.ERROR, message: report.stoppedBy });
      }
      span.end();
    }
    return report;
  });
}

async function detect(deps: DetectionRunDeps, report: DetectionRunReport): Promise<void> {
  const now = deps.now();
  let events: Awaited<ReturnType<CalendarClient["listEvents"]>>;
  let candidates: readonly InterviewCandidate[];
  try {
    events = await deps.calendar.listEvents({
      timeMin: now,
      timeMax: new Date(now.getTime() + DETECTION_WINDOW_DAYS * DAY_MS),
    });
    candidates = await deps.candidates();
  } catch {
    // A failed read stores nothing; the next run reads the same window again.
    report.stoppedBy = "read";
    return;
  }
  report.events = events.length;
  for (const event of events) {
    const found = detectInterview(event, candidates);
    if (found.kind === "ambiguous") {
      report.ambiguous++;
      continue;
    }
    if (found.kind === "none") {
      if (found.reason === "cancelled") report.cancelled++;
      else if (found.reason === "not_interview") report.notInterview++;
      else report.noMatch++;
      continue;
    }
    report.interviews++;
    // The daily limit is spent: further interviews this run would only be refused again.
    if (report.dailyLimit > 0) continue;
    let result: DetectionRecordResult;
    try {
      result = await deps.record({
        applicationId: found.applicationId,
        calendarEventId: event.id,
        format: found.format,
        start: found.start,
        end: found.end,
        // The addresses stay in memory: only how many interviewers there are is stored.
        interviewerCount: found.interviewers.length,
      });
    } catch {
      // The store failed: stop, and let the next run try the window again.
      report.stoppedBy = "record";
      return;
    }
    if (result.ok) {
      if (result.recorded) report.recorded++;
      else report.unchanged++;
      continue;
    }
    if (result.kind === "InvalidDetection" || result.kind === "UnknownApplication") {
      report.skipped++;
      continue;
    }
    const letter: DetectionLetter =
      result.kind === "TooManyChanges"
        ? {
            kind: DETECTION_DEAD_LETTER_KIND,
            reasonCode: "too_many_changes",
            subject: `application:${found.applicationId}`,
            // One letter per event and application, however many runs see it again.
            idempotencyKey: `interview_detection:${found.applicationId}:${eventKey(event.id)}`,
          }
        : {
            kind: DETECTION_DEAD_LETTER_KIND,
            reasonCode: "daily_limit",
            subject: `candidate:${deps.candidateId}`,
            // One letter per UTC day.
            idempotencyKey: `interview_detection:daily_limit:${now.toISOString().slice(0, 10)}`,
          };
    if (result.kind === "TooManyChanges") report.tooManyChanges++;
    else report.dailyLimit++;
    try {
      await deps.deadLetter(letter);
    } catch {
      // A refusal that can't be made visible must not pass silently: stop the run.
      report.stoppedBy = "dead_letter";
      return;
    }
  }
}
