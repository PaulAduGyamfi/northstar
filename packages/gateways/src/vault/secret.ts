// A plaintext from the vault (NS-122, CRD-002). It prints `[redacted]` in strings, JSON and
// `util.inspect`, so a log line or a span attribute that touches it by mistake shows nothing.
// Only the gateway step that types the password calls reveal().

const REDACTED = "[redacted]";

export class VaultSecret {
  // A private field: not an own property, so JSON.stringify and spreading never see it.
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}
