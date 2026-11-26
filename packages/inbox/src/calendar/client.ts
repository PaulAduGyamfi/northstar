import { admit, type CallGuard, type GuardOutcome } from "@northstar/llm";
import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
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
const MAX_RETRIES = 5;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "RATE_LIMIT_EXCEEDED",
  "RESOURCE_EXHAUSTED",
]);
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

// Calendar's own trouble (no answer, or a 429, 5xx or rate limit that outlasted the retries), as
// opposed to Calendar answering that the request is wrong. Only these count against the breaker.
const FAULTS = new WeakSet<CalendarError>();
const fault = (e: CalendarError) => {
  FAULTS.add(e);
  return e;
};

export type CalendarClient = {
  listEvents: (window: { timeMin: Date; timeMax: Date }) => Promise<CalendarEvent[]>;
};

// Google's fixed reason code for an error, never its message text (which can echo the request).
const REASON_WORD = /^[A-Za-z_]{1,64}$/;
async function errorReason(res: Response): Promise<string | null> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const error = (body as { error?: Record<string, unknown> } | null)?.error;
  if (!error || typeof error !== "object") return null;
  const legacy = Array.isArray(error.errors)
    ? (error.errors[0] as { reason?: unknown } | undefined)
    : undefined;
  for (const candidate of [legacy?.reason, error.status]) {
    if (typeof candidate === "string" && REASON_WORD.test(candidate)) return candidate;
  }
  return null;
}

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

export function createCalendarClient(deps: CalendarDeps): CalendarClient {
  const tracer = trace.getTracer("@northstar/inbox");
  const backoff = (attempt: number) => 500 * 2 ** attempt + Math.floor(deps.random() * 250);
  const rateBackoff = (attempt: number) => 2000 * 2 ** attempt + Math.floor(deps.random() * 250);

  // One GET with retries. Records the final status and retry count on the span.
  async function send(url: string, span: Span): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await deps.fetch(url, {
          method: "GET",
          headers: { authorization: deps.access.authorization() },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        // A dropped connection or timeout is retried like a 503.
        if (attempt < MAX_RETRIES) {
          await deps.sleep(backoff(attempt));
          continue;
        }
        throw fault(new CalendarError(`Calendar didn't answer (${(e as Error).name})`, 0));
      }
      span.setAttribute("http.response.status_code", res.status);
      span.setAttribute("calendar.retries", attempt);
      if (res.ok) return res.json();
      const reason = await errorReason(res);
      const said = `Calendar answered ${res.status}${reason ? ` (${reason})` : ""}`;
      // Google sends rate limits as 403 too; those are retried, other 403s aren't.
      const rateLimited =
        (res.status === 403 || res.status === 429) &&
        reason !== null &&
        RATE_LIMIT_REASONS.has(reason);
      if (!RETRYABLE.has(res.status) && !rateLimited) throw new CalendarError(said, res.status);
      if (attempt >= MAX_RETRIES) {
        throw fault(new CalendarError(`${said} after ${MAX_RETRIES} retries`, res.status));
      }
      await deps.sleep(rateLimited ? rateBackoff(attempt) : backoff(attempt));
    }
  }

  // One read through the `calendar` breaker: held back (HeldBack, nothing sent) while it is open,
  // and reported after the retries, as Calendar's failure only when it is Calendar's.
  async function get(url: string, span: Span): Promise<unknown> {
    const guard = deps.guard;
    if (!guard) return send(url, span);
    const admission = await admit(guard, { subsystem: null, dependency: CALENDAR_DEPENDENCY });
    if (!admission.ok) {
      span.setAttribute("calendar.held_by", admission.held.by);
      if (admission.errorName !== null)
        span.setAttribute("calendar.guard_error", admission.errorName);
      throw admission.held;
    }
    const report = async (outcome: GuardOutcome) => {
      try {
        await guard.report(CALENDAR_DEPENDENCY, outcome, admission.probeToken);
      } catch {
        span.setAttribute("calendar.breaker_report_failed", true);
      }
    };
    try {
      const body = await send(url, span);
      await report({ ok: true });
      return body;
    } catch (e) {
      const isFault = e instanceof CalendarError && FAULTS.has(e);
      await report(isFault ? { ok: false, error: "CalendarError" } : { ok: true });
      throw e;
    }
  }

  return {
    listEvents: ({ timeMin, timeMax }) =>
      tracer.startActiveSpan("calendar.list", async (span) => {
        try {
          const windowMs = timeMax.getTime() - timeMin.getTime();
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
