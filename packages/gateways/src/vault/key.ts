import { createHash } from "node:crypto";

// The vault's master key (NS-122, CRD-001): 32 random bytes, base64, in a key file outside the
// repo and the database (P1: a local file; hosted: cloud KMS later). Only the Apply Gateway
// loads it. Errors name the setting, never the path or the key.

// Opaque: the bytes live in a private field, so code holding a MasterKey (an entry point) can
// pass it on but can't read it. Only keyBytes reads them, and only src/vault/seal.ts and
// open.ts may import it (the boundary test enforces that).
export class MasterKey {
  // A SHA-256 fingerprint stored with each secret, so a wrong key is reported, not misused.
  readonly id: string;
  readonly #bytes: Uint8Array;

  private constructor(bytes: Uint8Array) {
    this.id = createHash("sha256").update(bytes).digest("hex");
    this.#bytes = Uint8Array.from(bytes);
  }

  static from(bytes: Uint8Array): MasterKey {
    if (bytes.length !== KEY_BYTES) throw new Error("vault master key must be 32 bytes");
    return new MasterKey(bytes);
  }

  static bytesOf(key: MasterKey): Uint8Array {
    return key.#bytes;
  }

  toString(): string {
    return `[vault key ${this.id.slice(0, 8)}]`;
  }

  toJSON(): string {
    return this.toString();
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

const KEY_BYTES = 32;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export const masterKeyFrom = (bytes: Uint8Array): MasterKey => MasterKey.from(bytes);

// The key's bytes, for sealing and opening only (src/vault/seal.ts and open.ts).
export const keyBytes = (key: MasterKey): Uint8Array => MasterKey.bytesOf(key);

// Reads VAULT_MASTER_KEY_FILE from the settings the entry point passes in (the one typed config
// path; app code never reads process.env), then the file through readFile, injected so tests
// need no disk. The file holds the key as base64.
export async function loadVaultKey(
  settings: Record<string, string | undefined>,
  readFile: (path: string) => Promise<string>,
): Promise<MasterKey> {
  const path = settings.VAULT_MASTER_KEY_FILE;
  if (path === undefined || path.trim() === "") throw new Error("VAULT_MASTER_KEY_FILE is not set");
  let text: string;
  try {
    text = await readFile(path);
  } catch {
    throw new Error("VAULT_MASTER_KEY_FILE could not be read");
  }
  const trimmed = text.trim();
  const bytes = BASE64.test(trimmed) ? Buffer.from(trimmed, "base64") : null;
  if (bytes === null || bytes.length !== KEY_BYTES) {
    throw new Error("VAULT_MASTER_KEY_FILE must hold 32 bytes as base64");
  }
  return MasterKey.from(bytes);
}
