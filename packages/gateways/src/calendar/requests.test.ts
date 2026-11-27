import type { CallDecision } from "@northstar/domain";
import { trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarWriteAccess } from "./access.js";
import { CalendarWriteError, CalendarWriteHeldBack } from "./errors.js";
import {
  createCalendarWriteClient,
  NORTHSTAR_CALENDAR_MARKER,
  type PrepEvent,
  requestAllowed,
} from "./requests.js";

// The Calendar writer's requests (NS-241 slice 3, ADR-0031 items 5 and 6) with Google faked: the
// global fetch is stubbed per test, never the network. Invented ids and a fake token only.

const API = "https://www.googleapis.com/calendar/v3";
const CALENDARS = `${API}/calendars`;
const LIST = `${API}/users/me/calendarList?minAccessRole=owner&maxResults=250&fields=items(id%2Cdescription)`;
const CAL_ID = "c0ffee12ab@group.calendar.google.com";
const EVENTS = `${CALENDARS}/c0ffee12ab%40group.calendar.google.com/events?sendUpdates=none`;
const calendarBody = JSON.stringify({
  summary: "Northstar",
  description: NORTHSTAR_CALENDAR_MARKER,
});
const event = {
  id: "a1b2c3d4e5f6",
  summary: "Interview prep",
  start: { dateTime: "2026-11-30T09:00:00.000Z" },
  end: { dateTime: "2026-11-30T09:45:00.000Z" },
};
const eventBody = (over: Record<string, unknown> = {}) => JSON.stringify({ ...event, ...over });

describe("the Calendar writer's request allowlist (ADR-0031 item 6)", () => {
  it("allows creating the Northstar calendar, reading the calendar list and inserting one prep event", () => {
    expect([
      requestAllowed("POST", CALENDARS, calendarBody),
      requestAllowed("GET", LIST, undefined),
      requestAllowed("POST", EVENTS, eventBody()),
    ]).toEqual([true, true, true]);
  });

  it.each([
    [
      "an event with attendees",
      "POST",
      EVENTS,
      eventBody({ attendees: [{ email: "x@example.com" }] }),
    ],
    ["an event with conference data", "POST", EVENTS, eventBody({ conferenceData: {} })],
    ["an event with a description", "POST", EVENTS, eventBody({ description: "Initech" })],
    ["an event with a location", "POST", EVENTS, eventBody({ location: "HQ" })],
    ["an event with reminders", "POST", EVENTS, eventBody({ reminders: { useDefault: true } })],
    ["an event with a free-text title", "POST", EVENTS, eventBody({ summary: "Prep: Initech" })],
    [
      "an event with a time zone",
      "POST",
      EVENTS,
      eventBody({ start: { dateTime: "2026-11-30T09:00:00.000Z", timeZone: "UTC" } }),
    ],
    [
      "an event with a local time",
      "POST",
      EVENTS,
      eventBody({ start: { dateTime: "2026-11-30T09:00:00-05:00" } }),
    ],
    ["an event id Google wouldn't accept", "POST", EVENTS, eventBody({ id: "ABC-123" })],
    [
      "inserting with guest emails",
      "POST",
      EVENTS.replace("sendUpdates=none", "sendUpdates=all"),
      eventBody(),
    ],
    ["inserting with a meeting link", "POST", `${EVENTS}&conferenceDataVersion=1`, eventBody()],
    [
      "inserting on the primary calendar",
      "POST",
      `${CALENDARS}/primary/events?sendUpdates=none`,
      eventBody(),
    ],
    [
      "updating an event",
      "PUT",
      `${CALENDARS}/c0ffee12ab%40group.calendar.google.com/events/a1b2c3d4e5f6`,
      eventBody(),
    ],
    [
      "deleting an event",
      "DELETE",
      `${CALENDARS}/c0ffee12ab%40group.calendar.google.com/events/a1b2c3d4e5f6`,
      undefined,
    ],
    [
      "moving an event",
      "POST",
      `${CALENDARS}/c0ffee12ab%40group.calendar.google.com/events/a1b2c3d4e5f6/move`,
      undefined,
    ],
    [
      "a calendar with another name",
      "POST",
      CALENDARS,
      JSON.stringify({ summary: "Work", description: NORTHSTAR_CALENDAR_MARKER }),
    ],
    [
      "a calendar with another key",
      "POST",
      CALENDARS,
      JSON.stringify({
        summary: "Northstar",
        description: NORTHSTAR_CALENDAR_MARKER,
        timeZone: "UTC",
      }),
    ],
    ["a calendar list with another query", "GET", `${API}/users/me/calendarList`, undefined],
    ["reading events", "GET", `${CALENDARS}/primary/events`, undefined],
    ["a body that isn't JSON", "POST", EVENTS, "id=a1b2c3d4e5f6"],
    [
      "a lookalike host",
      "POST",
      "https://www.googleapis.com.example.com/calendar/v3/calendars",
      calendarBody,
    ],
  ])("refuses %s", (_what, method, url, body) => {
    expect(requestAllowed(method, url, body)).toBe(false);
  });
});

const ALLOW: CallDecision = { allowed: true, probe: false };
const span = trace.getTracer("test").startSpan("test");
const PREP: PrepEvent = {
  id: "a1b2c3d4e5f6",
  kind: "prep",
  start: new Date("2026-11-30T09:00:00Z"),
  end: new Date("2026-11-30T09:45:00Z"),
};

type Call = { url: string; init: RequestInit };
function fakeGoogle(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return answer(call);
  });
  return calls;
}

function client(over: { on?: boolean; decision?: CallDecision } = {}) {
  const reports: unknown[] = [];
  const c = createCalendarWriteClient({
    access: new CalendarWriteAccess("test-key", [
      "https://www.googleapis.com/auth/calendar.app.created",
    ]),
    guard: {
      isOn: async () => over.on ?? true,
      acquire: async () => over.decision ?? ALLOW,
      report: async (_dep, outcome) => {
        reports.push(outcome);
      },
    },
  });
  return { c, reports };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("createCalendarWriteClient", () => {
  it("inserts a prep block with exactly the hashed fields and sendUpdates=none", async () => {
    const calls = fakeGoogle(() => json(200, { id: PREP.id }));
    const { c } = client();
    expect(await c.insertPrepEvent(CAL_ID, PREP, span)).toBe("created");
    expect([calls[0]?.url, JSON.parse(String(calls[0]?.init.body))]).toEqual([EVENTS, event]);
  });

  it("answers exists when the event id is already on the calendar, so a retry writes nothing new", async () => {
    fakeGoogle(() => json(409, { error: { errors: [{ reason: "duplicate" }] } }));
    const { c, reports } = client();
    expect([await c.insertPrepEvent(CAL_ID, PREP, span), reports]).toEqual([
      "exists",
      [{ ok: true }],
    ]);
  });

  it("gives the warm-up its own fixed title", async () => {
    const calls = fakeGoogle(() => json(200, {}));
    await client().c.insertPrepEvent(CAL_ID, { ...PREP, kind: "warm_up" }, span);
    expect(JSON.parse(String(calls[0]?.init.body)).summary).toBe("Interview warm-up");
  });

  it("sends nothing while the calendar_writes switch is off", async () => {
    const calls = fakeGoogle(() => json(200, {}));
    const error = await client({ on: false })
      .c.insertPrepEvent(CAL_ID, PREP, span)
      .catch((e) => e);
    expect([error instanceof CalendarWriteHeldBack && error.by, calls.length]).toEqual([
      "kill_switch",
      0,
    ]);
  });

  it("sends nothing while the calendar breaker is open", async () => {
    const calls = fakeGoogle(() => json(200, {}));
    const retryAt = new Date("2026-11-27T21:00:00Z");
    const { c } = client({ decision: { allowed: false, retryAt, lastError: null } });
    const error = await c.insertPrepEvent(CAL_ID, PREP, span).catch((e) => e);
    expect([error instanceof CalendarWriteHeldBack && error.retryAt, calls.length]).toEqual([
      retryAt,
      0,
    ]);
  });

  it("refuses a calendar id, event id or times it shouldn't send, before any request", async () => {
    const calls = fakeGoogle(() => json(200, {}));
    const { c } = client();
    const errors = await Promise.all([
      c.insertPrepEvent("primary", PREP, span).catch((e) => e.message),
      c.insertPrepEvent(CAL_ID, { ...PREP, id: "Bad-Id" }, span).catch((e) => e.message),
      c.insertPrepEvent(CAL_ID, { ...PREP, end: PREP.start }, span).catch((e) => e.message),
    ]);
    expect([errors, calls.length]).toEqual([["calendarId", "id", "time"], 0]);
  });

  it("counts a 5xx against the breaker and reports its status and reason only", async () => {
    fakeGoogle(() =>
      json(503, { error: { message: "secret text", errors: [{ reason: "backendError" }] } }),
    );
    const { c, reports } = client();
    const error = await c.insertPrepEvent(CAL_ID, PREP, span).catch((e) => e);
    expect([error instanceof CalendarWriteError && error.message, reports]).toEqual([
      "Calendar answered 503 (backendError)",
      [{ ok: false, error: "CalendarWriteError" }],
    ]);
  });

  it("creates the Northstar calendar with the fixed name and marker and returns its id", async () => {
    const calls = fakeGoogle(() => json(200, { id: CAL_ID }));
    expect(await client().c.createCalendar(span)).toBe(CAL_ID);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      summary: "Northstar",
      description: NORTHSTAR_CALENDAR_MARKER,
    });
  });

  it("finds the calendar by its marker, never by its name", async () => {
    fakeGoogle(() =>
      json(200, {
        items: [
          { id: "aaaa1111@group.calendar.google.com", description: "Northstar" },
          { id: CAL_ID, description: NORTHSTAR_CALENDAR_MARKER },
        ],
      }),
    );
    expect(await client().c.findMarkedCalendar(span)).toBe(CAL_ID);
  });

  it("answers null when no calendar carries the marker", async () => {
    fakeGoogle(() => json(200, { items: [{ id: CAL_ID, description: "Northstar" }] }));
    expect(await client().c.findMarkedCalendar(span)).toBeNull();
  });

  it("sends the write token only in the Authorization header", async () => {
    const calls = fakeGoogle(() => json(200, { id: CAL_ID }));
    await client().c.createCalendar(span);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect([headers.authorization, String(calls[0]?.init.body).includes("test-key")]).toEqual([
      "Bearer test-key",
      false,
    ]);
  });

  it("refuses an answer without a calendar id", async () => {
    fakeGoogle(() => json(200, { id: "primary" }));
    const error = await client()
      .c.createCalendar(span)
      .catch((e) => e);
    expect(error instanceof CalendarWriteError).toBe(true);
  });
});
