import { inspect } from "node:util";

// The Calendar reader's own token (NS-240, ADR-0026): `calendar.events.readonly` on its own
// consent, never added to the Gmail token. Its own private field makes it a distinct type, so it
// can't be passed where a GmailAccess or GmailLabelAccess is expected, nor the other way round.
// Only the Calendar consent flow (once Paul accepts ADR-0026) should construct one. It prints a
// mask, never the token.
export class CalendarAccess {
  readonly #calendarToken: string;
  constructor(token: string) {
    this.#calendarToken = token;
  }
  authorization(): string {
    return `Bearer ${this.#calendarToken}`;
  }
  toJSON(): string {
    return "[CalendarAccess]";
  }
  toString(): string {
    return "[CalendarAccess]";
  }
  [inspect.custom](): string {
    return "[CalendarAccess]";
  }
}
