import { inspect } from "node:util";

// The label writer's own token (NS-229, ADR-0027). It holds `gmail.modify`, so it is a separate
// class from the mail reader's GmailAccess: each has its own private field, which TypeScript
// treats as a distinct type, so this token can't be passed to createGmailClient, triage or the
// Verification Catcher, and a read-only token can't drive the writer. Only the label consent flow
// (once Paul accepts ADR-0027) should construct one. It prints a mask, never the token.
export class GmailLabelAccess {
  readonly #labelToken: string;
  constructor(token: string) {
    this.#labelToken = token;
  }
  authorization(): string {
    return `Bearer ${this.#labelToken}`;
  }
  toJSON(): string {
    return "[GmailLabelAccess]";
  }
  toString(): string {
    return "[GmailLabelAccess]";
  }
  [inspect.custom](): string {
    return "[GmailLabelAccess]";
  }
}
