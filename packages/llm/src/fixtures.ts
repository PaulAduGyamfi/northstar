import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MessagesClient } from "./client.js";
import type { BetaMessage, MessageCreateParams } from "./sdk-types.js";

// JSON with object keys sorted at every level, so equal requests give equal text. Undefined
// values and functions are dropped, as JSON.stringify does.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return inner;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(inner).sort()) {
      sorted[key] = (inner as Record<string, unknown>)[key];
    }
    return sorted;
  });
}

// SHA-256 of the canonical request. Any change to prompt, model, effort, schema or input
// changes the key, so a stale recording can never answer a new request (ADR-0013).
export function requestKey(params: MessageCreateParams): string {
  return createHash("sha256").update(canonicalJson(params)).digest("hex");
}

export class MissingFixture extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`No recorded fixture for request ${key}. Re-record on purpose with eval --record.`);
    this.name = "MissingFixture";
    this.key = key;
  }
}

// A fixture file holds the response only. The request is represented by its SHA-256, so no
// prompt or input text is written to disk by the recorder. The field isn't called "key": secret
// scanners (gitleaks) read a long random value under a key-like name as an API key.
type FixtureFile = { requestSha256: string; response: BetaMessage };

const fixturePath = (dir: string, key: string) => join(dir, `${key}.json`);

// What a fixture may keep from a response. Fixtures are committed to a public repo, so:
// thinking blocks are dropped (they can restate the input, and replay never reads them), and a
// refusal's fallback credit token is nulled (it is an account-bound token).
function forFixture(response: BetaMessage): BetaMessage {
  const content = response.content.filter(
    (block) => block.type !== "thinking" && block.type !== "redacted_thinking",
  );
  const stopDetails = response.stop_details
    ? { ...response.stop_details, fallback_credit_token: null }
    : null;
  return { ...response, content, stop_details: stopDetails };
}

// Answers from recorded fixtures. Never touches the network.
export function createReplayClient(dir: string): MessagesClient {
  return {
    async create(params) {
      const key = requestKey(params);
      const path = fixturePath(dir, key);
      if (!existsSync(path)) throw new MissingFixture(key);
      const file = JSON.parse(readFileSync(path, "utf8")) as FixtureFile;
      return file.response;
    },
  };
}

// Calls the real client and saves each response as a fixture. Costs money: only `eval --record`
// uses it, run on purpose by Paul.
export function createRecordingClient(real: MessagesClient, dir: string): MessagesClient {
  return {
    async create(params, options) {
      const response = await real.create(params, options);
      const key = requestKey(params);
      mkdirSync(dir, { recursive: true });
      const file: FixtureFile = { requestSha256: key, response: forFixture(response) };
      // Trailing newline: the repo's end-of-file check requires it.
      writeFileSync(fixturePath(dir, key), `${JSON.stringify(file, null, 2)}\n`);
      return response;
    },
  };
}
