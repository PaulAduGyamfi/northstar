import { inspect } from "node:util";

// The scope ADR-0025 allows the draft writer, and the only one it accepts.
export const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";

// The Gmail draft writer's own token (NS-237 slice 4, ADR-0025 item 1). It holds `gmail.compose`,
// which can also send, so it is a class of its own: its private field makes TypeScript treat it as
// a distinct type, so it can never be passed where the mail reader's GmailAccess goes, and a
// read-only token can't drive the writer. It carries the scopes Google granted, so the writer can
// say `scope_missing` instead of trying. It prints a mask, never the token.
//
// The token itself has no public accessor (security review of NS-237 slice 4): a caller holding
// the object can't read it and `fetch` Gmail's send around the writer's allowlist. Only
// `bearerOf`, which the package entry doesn't export and which only src/mail/drafts.ts may name
// (the boundary test), reads it back.
const tokens = new WeakMap<GmailComposeAccess, string>();

export class GmailComposeAccess {
  // The type's own brand: no other token type has it, so a GmailAccess never stands in for this.
  readonly #compose = true;
  readonly scopes: readonly string[];
  constructor(token: string, scopes: readonly string[]) {
    tokens.set(this, token);
    this.scopes = [...scopes];
  }
  // Whether Google granted the compose scope (ADR-0025 item 6).
  hasComposeScope(): boolean {
    return this.#compose && this.scopes.includes(GMAIL_COMPOSE_SCOPE);
  }
  toJSON(): string {
    return "[GmailComposeAccess]";
  }
  toString(): string {
    return "[GmailComposeAccess]";
  }
  [inspect.custom](): string {
    return "[GmailComposeAccess]";
  }
}

// The Authorization header for the draft writer's own requests. Only src/mail/drafts.ts calls it.
export function bearerOf(access: GmailComposeAccess): string {
  const token = tokens.get(access);
  if (token === undefined) throw new TypeError("not a GmailComposeAccess");
  return `Bearer ${token}`;
}
