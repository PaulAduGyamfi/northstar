import { type CallOutcome, PREP_BLOCK_TITLES, PREP_CALENDAR_NAME } from "@northstar/domain";
import type { Span } from "@opentelemetry/api";
import { type CalendarWriteAccess, calendarBearer } from "./access.js";
import {
  CalendarWriteError,
  type CalendarWriteGuard,
  CalendarWriteHeldBack,
  CalendarWriteRequestError,
} from "./errors.js";

// The Calendar writer's requests (NS-241 slice 3, ADR-0031 items 5 and 6). Private to
// src/calendar/: a boundary test fails if anything else imports it. Its only Google writes are
// creating the Northstar calendar and inserting one prep event on it; its only read is the
// calendar-list lookup for the calendar's marker. Nothing here updates, moves or deletes, and the
// allowlist below refuses any other request whatever the code around it becomes.

const API = "https://www.googleapis.com/calendar/v3";
const CALENDARS_URL = `${API}/calendars`;
// One page of up to 250 calendars, deliberately: Paul's own account holds far fewer, and the
// marker lookup only runs after an unknown outcome (the stored id comes first, next slice).
const LIST_URL = `${API}/users/me/calendarList?minAccessRole=owner&maxResults=250&fields=items(id%2Cdescription)`;

// The calendar Northstar creates (CAL-001) and the fixed marker that finds it again after an
// unknown outcome (ADR-0031 item 5): never matched by name alone.
export const NORTHSTAR_CALENDAR_NAME = PREP_CALENDAR_NAME;
export const NORTHSTAR_CALENDAR_MARKER = "Northstar prep blocks [northstar:prep-calendar:v1]";

// Fixed titles only (ADR-0031, decided with acceptance): no company or interviewer name reaches
// Google. The same constant the prep plan's hash covers (packages/domain, prep-plan.ts).
export const PREP_EVENT_TITLES = PREP_BLOCK_TITLES;
export type PrepEventKind = keyof typeof PREP_EVENT_TITLES;

// One block as the writer sends it. The id is client-chosen (from the Gate decision and the
// block's index, next slice), so a repeated insert answers 409 instead of making a second event.
export type PrepEvent = { id: string; kind: PrepEventKind; start: Date; end: Date };

// Google's rules for a client-chosen event id: lowercase base32hex, 5 to 1024 characters.
const EVENT_ID = /^[a-v0-9]{5,1024}$/;
// A secondary calendar's id, as Google makes it for calendars.insert: `<letters and digits>@` and
// this domain. Exported so tests build their invented ids from it.
export const CALENDAR_ID_DOMAIN = "group.calendar.google.com";
// Newer calendars get ids like `c_<hex>`, so `_` is allowed; encodeURIComponent leaves it as is.
const CALENDAR_ID = /^[a-z0-9_]{1,128}@group\.calendar\.google\.com$/;
// An ISO time in UTC as Date#toISOString writes it: no time zone needs sending (ADR-0031 item 6).
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// The breaker every Calendar call goes through, and this writer's own kill switch (ADR-0007).
export const CALENDAR_WRITE_DEPENDENCY = "calendar";
export const CALENDAR_WRITE_SUBSYSTEM = "calendar_writes";
const TIMEOUT_MS = 30_000;

// The fixed base URL with every special character escaped, so the pattern below matches only
// Google's own host and path, a secondary calendar's encoded id (`@` as %40) and exactly
// `sendUpdates=none` with no other query (no conferenceDataVersion, no guest emails).
const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const EVENTS_URL = new RegExp(
  `^${literal(CALENDARS_URL)}/([a-z0-9_]{1,128})%40group\\.calendar\\.google\\.com/events\\?sendUpdates=none$`,
);

// Whether a request is one the writer may send:
// - create the Northstar calendar: a body of exactly the fixed name and marker;
// - read the calendar list with the fixed query, no body;
// - insert one event on a secondary calendar, with sendUpdates=none and a body of exactly id,
//   summary (a fixed title), start.dateTime and end.dateTime in UTC. So an insert can't invite,
//   email or add a meeting link under Paul's name (ADR-0031 item 6).
export function requestAllowed(method: string, url: string, body: unknown): boolean {
  if (url === LIST_URL) return method === "GET" && body === undefined;
  if (method !== "POST" || typeof body !== "string") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (!isPlainObject(parsed)) return false;
  if (url === CALENDARS_URL) {
    return (
      sameKeys(parsed, ["summary", "description"]) &&
      parsed.summary === NORTHSTAR_CALENDAR_NAME &&
      parsed.description === NORTHSTAR_CALENDAR_MARKER
    );
  }
  if (!EVENTS_URL.test(url)) return false;
  const titles: unknown[] = Object.values(PREP_EVENT_TITLES);
  return (
    sameKeys(parsed, ["id", "summary", "start", "end"]) &&
    typeof parsed.id === "string" &&
    EVENT_ID.test(parsed.id) &&
    titles.includes(parsed.summary) &&
    isTime(parsed.start) &&
    isTime(parsed.end)
  );
}

// `{ dateTime: "<UTC>" }` and nothing else: no timeZone, date or other key.
function isTime(v: unknown): boolean {
  return (
    isPlainObject(v) &&
    sameKeys(v, ["dateTime"]) &&
    typeof v.dateTime === "string" &&
    UTC_TIME.test(v.dateTime)
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sameKeys(o: Record<string, unknown>, keys: string[]): boolean {
  const want = [...keys].sort();
  const have = Object.keys(o).sort();
  return have.length === want.length && have.every((k, i) => k === want[i]);
}

// No fetch port (as for the draft writer): requests carry the write token in their Authorization
// header, so they go through the global fetch, never one a caller hands in.
export type CalendarWriteClientDeps = {
  access: CalendarWriteAccess;
  guard: CalendarWriteGuard;
};

export type CalendarWriteClient = {
  // Creates the Northstar calendar; returns its id.
  createCalendar: (span: Span) => Promise<string>;
  // The id of a calendar Paul owns that carries the marker, or null.
  findMarkedCalendar: (span: Span) => Promise<string | null>;
  // Inserts one block; `exists` when an event with this id is already there (a retry).
  insertPrepEvent: (
    calendarId: string,
    event: PrepEvent,
    span: Span,
  ) => Promise<"created" | "exists">;
};

export function createCalendarWriteClient(deps: CalendarWriteClientDeps): CalendarWriteClient {
  // One request through the allowlist, the kill switch and the breaker. Only Google's own trouble
  // (no answer, 429, 5xx) counts against the breaker; a 4xx means Google answered. `accept` lists
  // the non-2xx statuses the caller handles itself (409 for a repeated insert).
  async function call(
    url: string,
    init: RequestInit,
    span: Span,
    accept: number[] = [],
  ): Promise<Response> {
    if (!requestAllowed(init.method ?? "GET", url, init.body)) {
      throw new CalendarWriteRequestError("request outside the Calendar writer's allowlist");
    }
    let probeToken: string | null;
    try {
      if (!(await deps.guard.isOn(CALENDAR_WRITE_SUBSYSTEM))) {
        throw new CalendarWriteHeldBack("kill_switch", CALENDAR_WRITE_SUBSYSTEM, null);
      }
      const decision = await deps.guard.acquire(CALENDAR_WRITE_DEPENDENCY);
      if (!decision.allowed) {
        throw new CalendarWriteHeldBack("breaker", CALENDAR_WRITE_DEPENDENCY, decision.retryAt);
      }
      probeToken = decision.probe ? decision.probeToken : null;
    } catch (error) {
      if (error instanceof CalendarWriteHeldBack) {
        span.setAttribute("calendar.held_by", error.by);
        throw error;
      }
      // A check that throws holds the request back: no unguarded write.
      span.setAttribute("calendar.held_by", "guard_error");
      throw new CalendarWriteHeldBack("guard_error", CALENDAR_WRITE_DEPENDENCY, null);
    }
    const report = async (outcome: CallOutcome) => {
      try {
        await deps.guard.report(CALENDAR_WRITE_DEPENDENCY, outcome, probeToken);
      } catch {
        span.setAttribute("calendar.breaker_report_failed", true);
      }
    };
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { authorization: calendarBearer(deps.access), "content-type": "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      await report({ ok: false, error: "CalendarWriteError" });
      throw new CalendarWriteError(`Calendar didn't answer (${(e as Error).name})`, 0);
    }
    span.setAttribute("http.response.status_code", res.status);
    const fault = res.status === 429 || res.status >= 500;
    await report(fault ? { ok: false, error: "CalendarWriteError" } : { ok: true });
    if (!res.ok && !accept.includes(res.status)) {
      const reason = await errorReason(res);
      throw new CalendarWriteError(
        `Calendar answered ${res.status}${reason ? ` (${reason})` : ""}`,
        res.status,
      );
    }
    return res;
  }

  return {
    async createCalendar(span) {
      const res = await call(
        CALENDARS_URL,
        {
          method: "POST",
          body: JSON.stringify({
            summary: NORTHSTAR_CALENDAR_NAME,
            description: NORTHSTAR_CALENDAR_MARKER,
          }),
        },
        span,
      );
      const id = ((await readJson(res)) as { id?: unknown }).id;
      if (typeof id !== "string" || !CALENDAR_ID.test(id)) {
        throw new CalendarWriteError("Calendar answered without a calendar id", res.status);
      }
      return id;
    },

    async findMarkedCalendar(span) {
      const res = await call(LIST_URL, { method: "GET" }, span);
      const body = (await readJson(res)) as { items?: { id?: unknown; description?: unknown }[] };
      for (const item of body.items ?? []) {
        if (
          item.description === NORTHSTAR_CALENDAR_MARKER &&
          typeof item.id === "string" &&
          CALENDAR_ID.test(item.id)
        ) {
          return item.id;
        }
      }
      return null;
    },

    async insertPrepEvent(calendarId, event, span) {
      if (!CALENDAR_ID.test(calendarId)) throw new CalendarWriteRequestError("calendarId");
      if (!EVENT_ID.test(event.id)) throw new CalendarWriteRequestError("id");
      if (!Object.hasOwn(PREP_EVENT_TITLES, event.kind))
        throw new CalendarWriteRequestError("kind");
      if (
        Number.isNaN(event.start.getTime()) ||
        Number.isNaN(event.end.getTime()) ||
        event.end.getTime() <= event.start.getTime()
      ) {
        throw new CalendarWriteRequestError("time");
      }
      const url = `${CALENDARS_URL}/${encodeURIComponent(calendarId)}/events?sendUpdates=none`;
      // Exactly the hashed fields (ADR-0031 item 6): built here, never from caller-supplied JSON.
      const body = JSON.stringify({
        id: event.id,
        summary: PREP_EVENT_TITLES[event.kind],
        start: { dateTime: event.start.toISOString() },
        end: { dateTime: event.end.toISOString() },
      });
      const res = await call(url, { method: "POST", body }, span, [409]);
      // 409: an event with this id exists (a retry, or one Paul deleted): already written.
      return res.status === 409 ? "exists" : "created";
    },
  };
}

// Google's reason code from an error body (`rateLimitExceeded`), or "". Only a code of plain
// letters is kept: the message text could quote anything.
async function errorReason(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { errors?: { reason?: unknown }[] } };
    const reason = body.error?.errors?.[0]?.reason;
    return typeof reason === "string" && /^[A-Za-z]{1,40}$/.test(reason) ? reason : "";
  } catch {
    return "";
  }
}

// A success body, or a CalendarWriteError: a parse error's message can quote the body.
async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new CalendarWriteError("Calendar sent an unreadable answer", res.status);
  }
}
