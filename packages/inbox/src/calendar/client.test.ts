import { type CallGuard, type GuardDecision, type GuardOutcome, HeldBack } from "@northstar/llm";
import { describe, expect, it } from "vitest";
import { detectInterview } from "../interview/detect.js";
import { GmailAccess } from "../oauth.js";
import { CalendarAccess } from "./access.js";
import {
  CALENDAR_DEPENDENCY,
  CalendarError,
  createCalendarClient,
  EVENT_FIELDS,
  MAX_WINDOW_DAYS,
} from "./client.js";

// The read-only Calendar client (NS-240, ADR-0026) on a fake fetch. Synthetic events only.

const TOKEN = "ya29.test-calendar-token";
const FROM = new Date("2026-12-01T00:00:00Z");
const TO = new Date("2026-12-15T00:00:00Z");

type Item = Record<string, unknown>;
const timed = (id: string, summary: string, over: Item = {}): Item => ({
  id,
  summary,
  status: "confirmed",
  start: { dateTime: "2026-12-03T15:00:00Z" },
  end: { dateTime: "2026-12-03T16:00:00Z" },
  organizer: { email: "recruiter@globex.example" },
  attendees: [{ email: "recruiter@globex.example" }, { email: "candidate@example.com" }],
  ...over,
});

// A fake Calendar API: pages of items, then scripted failures before them.
function fakeCalendar(pages: Item[][], failures: { status: number; body?: string }[] = []) {
  const requests: { url: URL; method: string; authorization: string | null }[] = [];
  const queue = [...failures];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({
      url,
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
    });
    const failure = queue.shift();
    if (failure) return new Response(failure.body ?? "{}", { status: failure.status });
    const page = Number(url.searchParams.get("pageToken") ?? "0");
    const next = page + 1 < pages.length ? String(page + 1) : undefined;
    return Response.json({ items: pages[page] ?? [], ...(next ? { nextPageToken: next } : {}) });
  }) as typeof fetch;
  return { fetch: fetchFn, requests };
}

function guardWith(decision: GuardDecision = { allowed: true, probe: false }) {
  const reports: GuardOutcome[] = [];
  const acquired: string[] = [];
  const guard: CallGuard = {
    isOn: async () => true,
    acquire: async (dependency) => {
      acquired.push(dependency);
      return decision;
    },
    report: async (_dependency, outcome) => {
      reports.push(outcome);
    },
  };
  return { guard, reports, acquired };
}

const sleeps: number[] = [];
const client = (cal: ReturnType<typeof fakeCalendar>, guard?: CallGuard) =>
  createCalendarClient({
    access: new CalendarAccess(TOKEN),
    fetch: cal.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    ...(guard ? { guard } : {}),
  });

describe("listEvents", () => {
  it("reads only the primary calendar's events in the window, with the limited fields", async () => {
    const cal = fakeCalendar([[timed("e1", "Interview with Globex")]]);
    await client(cal).listEvents({ timeMin: FROM, timeMax: TO });
    const [request] = cal.requests;
    expect([
      request?.method,
      request?.url.origin + (request?.url.pathname ?? ""),
      Object.fromEntries(request?.url.searchParams ?? []),
      request?.authorization,
    ]).toEqual([
      "GET",
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      {
        timeMin: "2026-12-01T00:00:00.000Z",
        timeMax: "2026-12-15T00:00:00.000Z",
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "250",
        fields: EVENT_FIELDS,
      },
      `Bearer ${TOKEN}`,
    ]);
    expect(EVENT_FIELDS).toBe(
      "nextPageToken,items(id,summary,status,start(dateTime),end(dateTime),organizer(email),attendees(email))",
    );
  });

  it("maps each timed event for detectInterview, with no description", async () => {
    const cal = fakeCalendar([[timed("e1", "Interview with Globex")]]);
    const events = await client(cal).listEvents({ timeMin: FROM, timeMax: TO });
    expect(events).toEqual([
      {
        id: "e1",
        title: "Interview with Globex",
        description: null,
        start: new Date("2026-12-03T15:00:00Z"),
        end: new Date("2026-12-03T16:00:00Z"),
        status: "confirmed",
        organizer: "recruiter@globex.example",
        attendees: ["recruiter@globex.example", "candidate@example.com"],
      },
    ]);
    const detection = detectInterview(events[0] as (typeof events)[number], [
      {
        applicationId: "app-1",
        companyDomains: ["globex.example"],
        activeFrom: new Date("2026-11-01T00:00:00Z"),
        activeUntil: null,
      },
    ]);
    expect(detection.kind).toBe("interview");
  });

  it("follows every page", async () => {
    const cal = fakeCalendar([[timed("e1", "Interview")], [timed("e2", "Phone screen")]]);
    const events = await client(cal).listEvents({ timeMin: FROM, timeMax: TO });
    expect([events.map((e) => e.id), cal.requests.length]).toEqual([["e1", "e2"], 2]);
  });

  it("skips all-day events and items missing an id, a time or a known status", async () => {
    const cal = fakeCalendar([
      [
        timed("allday", "Offsite", { start: { date: "2026-12-04" }, end: { date: "2026-12-05" } }),
        timed("", "No id"),
        timed("nostart", "No start", { start: {} }),
        timed("odd", "Odd status", { status: "something-else" }),
        timed("bad-date", "Bad date", { start: { dateTime: "not a date" } }),
        timed("ok", "Interview"),
      ],
    ]);
    const events = await client(cal).listEvents({ timeMin: FROM, timeMax: TO });
    expect(events.map((e) => e.id)).toEqual(["ok"]);
  });

  it("keeps only plain string addresses for the organizer and attendees", async () => {
    const cal = fakeCalendar([
      [
        timed("e1", "Interview", {
          organizer: {},
          attendees: [{ email: "a@globex.example" }, { name: "no email" }, { email: 42 }],
        }),
      ],
    ]);
    const [event] = await client(cal).listEvents({ timeMin: FROM, timeMax: TO });
    expect([event?.organizer, event?.attendees]).toEqual([null, ["a@globex.example"]]);
  });

  it.each([
    ["an end before the start", TO, FROM],
    ["an empty window", FROM, FROM],
    ["a window over 60 days", FROM, new Date(FROM.getTime() + (MAX_WINDOW_DAYS + 1) * 86_400_000)],
  ])("refuses %s before sending anything", async (_name, timeMin, timeMax) => {
    const cal = fakeCalendar([[]]);
    await expect(client(cal).listEvents({ timeMin, timeMax })).rejects.toThrow(
      "the window must run forward and span at most 60 days",
    );
    expect(cal.requests).toEqual([]);
  });

  it("retries a 503 with backoff and then reads the events", async () => {
    sleeps.length = 0;
    const cal = fakeCalendar([[timed("e1", "Interview")]], [{ status: 503 }]);
    const events = await client(cal).listEvents({ timeMin: FROM, timeMax: TO });
    expect([events.length, sleeps]).toEqual([1, [500]]);
  });

  it("names Google's reason code, never its message, for a 403", async () => {
    const body = JSON.stringify({
      error: {
        code: 403,
        message: "Calendar API has not been used in project 123",
        errors: [{ reason: "accessNotConfigured" }],
      },
    });
    const cal = fakeCalendar([[]], [{ status: 403, body }]);
    const error = await client(cal)
      .listEvents({ timeMin: FROM, timeMax: TO })
      .catch((e: unknown) => e);
    expect([error instanceof CalendarError, (error as Error).message]).toEqual([
      true,
      "Calendar answered 403 (accessNotConfigured)",
    ]);
  });
});

describe("the calendar breaker", () => {
  it("asks the calendar breaker before a read and reports a success", async () => {
    const { guard, reports, acquired } = guardWith();
    await client(fakeCalendar([[]]), guard).listEvents({ timeMin: FROM, timeMax: TO });
    expect([CALENDAR_DEPENDENCY, acquired, reports]).toEqual([
      "calendar",
      ["calendar"],
      [{ ok: true }],
    ]);
  });

  it("sends nothing while the breaker is open and throws HeldBack", async () => {
    const retryAt = new Date("2026-12-01T01:00:00Z");
    const { guard, reports } = guardWith({ allowed: false, retryAt, lastError: null });
    const cal = fakeCalendar([[]]);
    const error = await client(cal, guard)
      .listEvents({ timeMin: FROM, timeMax: TO })
      .catch((e: unknown) => e);
    expect([error, cal.requests, reports]).toEqual([
      new HeldBack("breaker", "calendar", retryAt),
      [],
      [],
    ]);
  });

  it("counts a server error that outlasts the retries against the breaker", async () => {
    const { guard, reports } = guardWith();
    const cal = fakeCalendar(
      [[]],
      Array.from({ length: 6 }, () => ({ status: 503 })),
    );
    await expect(client(cal, guard).listEvents({ timeMin: FROM, timeMax: TO })).rejects.toThrow(
      "after 5 retries",
    );
    expect(reports).toEqual([{ ok: false, error: "CalendarError" }]);
  });

  it("doesn't count a 404 against the breaker: Calendar answered", async () => {
    const { guard, reports } = guardWith();
    const cal = fakeCalendar([[]], [{ status: 404 }]);
    await expect(client(cal, guard).listEvents({ timeMin: FROM, timeMax: TO })).rejects.toThrow(
      "Calendar answered 404",
    );
    expect(reports).toEqual([{ ok: true }]);
  });
});

describe("CalendarAccess", () => {
  it("prints a mask, never the token", () => {
    const access = new CalendarAccess(TOKEN);
    expect([String(access), JSON.stringify({ access })]).toEqual([
      "[CalendarAccess]",
      '{"access":"[CalendarAccess]"}',
    ]);
  });

  it("isn't interchangeable with the Gmail reader's token", () => {
    const takesCalendar = (_a: CalendarAccess) => true;
    const takesGmail = (_a: GmailAccess) => true;
    // @ts-expect-error a Gmail token can't read the calendar
    takesCalendar(new GmailAccess(TOKEN));
    // @ts-expect-error a Calendar token can't read mail
    takesGmail(new CalendarAccess(TOKEN));
    expect(true).toBe(true);
  });
});
