import { inspect } from "node:util";

// The scope ADR-0031 allows the Calendar writer, and the only one it accepts: the app may create
// secondary calendars and manage the events on calendars it created, nothing else.
export const CALENDAR_APP_CREATED_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";

// The Calendar writer's own token (NS-241 slice 3, ADR-0031 item 2). A class of its own: the
// private brand makes TypeScript treat it as a distinct type, so it never stands in for the
// read-only reader's CalendarAccess (packages/inbox) or the Gmail tokens. It prints a mask and has
// no public accessor, so a caller holding it can't read the token and call Google around the
// writer's allowlist. Only `calendarBearer`, which the package entry doesn't export and which only
// src/calendar/requests.ts may name (the boundary test), reads it back.
const tokens = new WeakMap<CalendarWriteAccess, string>();

export class CalendarWriteAccess {
  readonly #calendarWrite = true;
  readonly scopes: readonly string[];
  constructor(token: string, scopes: readonly string[]) {
    tokens.set(this, token);
    this.scopes = [...scopes];
  }
  // Whether Google granted calendar.app.created (ADR-0031 item 8: else `scope_missing`).
  hasWriteScope(): boolean {
    return this.#calendarWrite && this.scopes.includes(CALENDAR_APP_CREATED_SCOPE);
  }
  toJSON(): string {
    return "[CalendarWriteAccess]";
  }
  toString(): string {
    return "[CalendarWriteAccess]";
  }
  [inspect.custom](): string {
    return "[CalendarWriteAccess]";
  }
}

// The Authorization header for the writer's own requests. Only src/calendar/requests.ts calls it.
export function calendarBearer(access: CalendarWriteAccess): string {
  const token = tokens.get(access);
  if (token === undefined) throw new TypeError("not a CalendarWriteAccess");
  return `Bearer ${token}`;
}
