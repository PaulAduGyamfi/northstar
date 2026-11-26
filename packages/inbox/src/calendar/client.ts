import type { CallGuard } from "@northstar/llm";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { createGoogleGet } from "../google-get.js";
import type { CalendarEvent } from "../interview/detect.js";
import type { CalendarAccess } from "./access.js";

// The read-only Calendar client (NS-240, ADR-0026). Plain fetch, no SDK. It reads one thing: the
// events on Paul's primary calendar inside a window, with `fields=` limited so descriptions,
// locations and conference links are never fetched. Every read goes through the `calendar`
// breaker (NS-174). Errors and spans carry statuses, counts and Google's reason code only: never
// a title, an address or the token.

const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
// What detection reads (ADR-0026 item 3), and the page token. Nothing else is fetched.
export const EVENT_FIELDS =
  "nextPageToken,items(id,summary,status,start(dateTime),end(dateTime),organizer(email),attendees(email))";
// Detection looks a few weeks ahead; a wider window would read more of Paul's calendar than it needs.
export const MAX_WINDOW_DAYS = 60;
export const CALENDAR_DEPENDENCY = "calendar";
const PAGE_SIZE = 250;
// A runaway paging loop stops here (60 days of a busy calendar is well under 10 pages).
const MAX_PAGES = 20;
const STATUSES = new Set(["confirmed", "tentative", "cancelled"]);
const DAY_MS = 86_400_000;

export type CalendarDeps = {
  access: CalendarAccess;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  // 0..1, for backoff jitter (injected so tests are exact).
  random: () => number;
  // The `calendar` breaker. Without one, reads go out unguarded (tests, tools).
  guard?: CallGuard;
};

export class CalendarError extends Error {
  override name = "CalendarError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type CalendarClient = {
  listEvents: (window: { timeMin: Date; timeMax: Date }) => Promise<CalendarEvent[]>;
};

// One item as detectInterview's event, or null when it can't be read without guessing: no id, an
// all-day event (an interview has a time), a time that isn't one, or an unknown status.
function toEvent(raw: unknown): CalendarEvent | null {
  if (raw === null || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const time = (v: unknown): Date | null => {
    const dateTime = (v as { dateTime?: unknown } | null)?.dateTime;
    if (typeof dateTime !== "string") return null;
    const d = new Date(dateTime);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const start = time(item.start);
  const end = time(item.end);
  const status = item.status;
  if (typeof item.id !== "string" || item.id === "" || start === null || end === null) return null;
  if (typeof status !== "string" || !STATUSES.has(status)) return null;
  const email = (v: unknown): string | null => {
    const e = (v as { email?: unknown } | null)?.email;
    return typeof e === "string" && e !== "" ? e : null;
  };
  const attendees = Array.isArray(item.attendees)
    ? item.attendees.map(email).filter((e): e is string => e !== null)
    : [];
  return {
    id: item.id,
    title: typeof item.summary === "string" ? item.summary : "",
    // Never fetched (ADR-0026 item 3): the description is whatever the invite's author typed.
    description: null,
    start,
    end,
    status: status as CalendarEvent["status"],
    organizer: email(item.organizer),
    attendees,
  };
}

// Only GET on the primary events URL, with exactly EVENT_FIELDS and the known parameters.
const ALLOWED_PARAMS = new Set([
  "timeMin",
  "timeMax",
  "singleEvents",
  "orderBy",
  "maxResults",
  "fields",
  "pageToken",
]);
export function requestAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.origin + parsed.pathname !== EVENTS) return false;
  if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") return false;
  if (parsed.searchParams.get("fields") !== EVENT_FIELDS) return false;
  if (parsed.searchParams.getAll("fields").length !== 1) return false;
  return [...parsed.searchParams.keys()].every((k) => ALLOWED_PARAMS.has(k));
}

export function createCalendarClient(deps: CalendarDeps): CalendarClient {
  const tracer = trace.getTracer("@northstar/inbox");
  // Retries, Google's reason code and the `calendar` breaker: the shared Google GET (NS-250).
  const get = createGoogleGet(
    {
      label: "Calendar",
      dependency: CALENDAR_DEPENDENCY,
      attrPrefix: "calendar",
      errorName: "CalendarError",
      makeError: (message, status) => new CalendarError(message, status),
      method: "GET",
      // A runtime check beside the boundary scan: only the primary calendar's events, with exactly
      // the limited fields, ever go out.
      check: (url) =>
        requestAllowed(url) ? null : new CalendarError("refused: not the primary events read", 0),
      // The parse error can quote the body (event titles): never pass it on.
      notJson: () => new CalendarError("Calendar answered 200 with a body that isn't JSON", 200),
    },
    {
      authorization: () => deps.access.authorization(),
      fetch: deps.fetch,
      sleep: deps.sleep,
      random: deps.random,
      ...(deps.guard ? { guard: deps.guard } : {}),
    },
  );

  return {
    listEvents: ({ timeMin, timeMax }) =>
      tracer.startActiveSpan("calendar.list", async (span) => {
        try {
          const windowMs = timeMax.getTime() - timeMin.getTime();
          // A plain Error: a bad window is the caller's bug, not Calendar's answer.
          if (!(windowMs > 0) || windowMs > MAX_WINDOW_DAYS * DAY_MS) {
            throw new Error("the window must run forward and span at most 60 days");
          }
          const events: CalendarEvent[] = [];
          let skipped = 0;
          let pageToken: string | undefined;
          let pages = 0;
          do {
            const url = new URL(EVENTS);
            url.searchParams.set("timeMin", timeMin.toISOString());
            url.searchParams.set("timeMax", timeMax.toISOString());
            url.searchParams.set("singleEvents", "true");
            url.searchParams.set("orderBy", "startTime");
            url.searchParams.set("maxResults", String(PAGE_SIZE));
            url.searchParams.set("fields", EVENT_FIELDS);
            if (pageToken) url.searchParams.set("pageToken", pageToken);
            const page = (await get(url.toString(), span)) as {
              items?: unknown[];
              nextPageToken?: unknown;
            };
            for (const raw of page.items ?? []) {
              const event = toEvent(raw);
              if (event === null) skipped++;
              else events.push(event);
            }
            pageToken = typeof page.nextPageToken === "string" ? page.nextPageToken : undefined;
            pages++;
          } while (pageToken && pages < MAX_PAGES);
          // Never a silent partial list: more pages than the cap is an error, not a result.
          if (pageToken) {
            span.setAttribute("calendar.truncated", true);
            throw new CalendarError(`Calendar had more than ${MAX_PAGES} pages`, 200);
          }
          // Counts only: never a title or an address.
          span.setAttribute("calendar.count", events.length);
          span.setAttribute("calendar.skipped", skipped);
          return events;
        } catch (e) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).name });
          throw e;
        } finally {
          span.end();
        }
      }),
  };
}
