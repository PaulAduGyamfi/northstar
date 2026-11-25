// A verification code or magic link (VER-005). It is a secret for a few minutes: it must never
// reach a log, a span, an event or the feed. Wrapping it means a result logged or serialized by
// mistake prints "[redacted]"; only the gateway that uses it calls reveal().

const REDACTED = "[redacted]";

export class VerificationSecret {
  // A private field: not an own property, so JSON.stringify and spreading never see it.
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  // The value itself, for the gateway step that types the code or opens the link.
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  // Node's util.inspect (console.log, most loggers' pretty printers) calls this.
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}
