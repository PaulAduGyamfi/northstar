import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  createRecordingClient,
  createReplayClient,
  MissingFixture,
  requestKey,
} from "./fixtures.js";
import { buildRequest } from "./request.js";
import type { BetaMessage } from "./sdk-types.js";
import { fakeClient } from "./test/fake-client.js";
import { okMessage, refusalMessage } from "./test/responses.js";
import { testRoute } from "./test/test-route.js";

const freshDir = () => mkdtempSync(join(tmpdir(), "llm-fixtures-"));
const request = () => buildRequest(testRoute, { jobText: "Remote role at Example Corp." });

describe("canonicalJson", () => {
  it("gives the same text whatever order the keys were written in", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      canonicalJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }),
    );
  });

  it("leaves out undefined values and functions", () => {
    expect(canonicalJson({ a: undefined, b: () => 1, c: 2 })).toBe('{"c":2}');
  });
});

describe("recorded fixtures", () => {
  it("record then replay returns the recorded response", async () => {
    const dir = freshDir();
    const { params, options } = request();
    const recorder = createRecordingClient(fakeClient([okMessage()]), dir);
    await recorder.create(params, options);

    const replayed = await createReplayClient(dir).create(params, options);
    expect(replayed).toEqual(okMessage());
  });

  it("names the fixture file by the request key and stores no request text", async () => {
    const dir = freshDir();
    const { params, options } = request();
    await createRecordingClient(fakeClient([okMessage()]), dir).create(params, options);

    expect(readdirSync(dir)).toEqual([`${requestKey(params)}.json`]);
    const stored = readFileSync(join(dir, `${requestKey(params)}.json`), "utf8");
    expect(stored).not.toContain("Example Corp");
    expect(stored.endsWith("}\n")).toBe(true);
  });

  it("treats a changed prompt as a missing fixture instead of replaying a stale answer", async () => {
    const dir = freshDir();
    const { params, options } = request();
    await createRecordingClient(fakeClient([okMessage()]), dir).create(params, options);

    const changedRoute = {
      ...testRoute,
      prompt: { ...testRoute.prompt, version: 2, text: "New." },
    };
    const changed = buildRequest(changedRoute, { jobText: "Remote role at Example Corp." });
    const replay = createReplayClient(dir).create(changed.params, changed.options);
    await expect(replay).rejects.toEqual(new MissingFixture(requestKey(changed.params)));
  });

  it("never writes a refusal's fallback credit token into a fixture", async () => {
    const dir = freshDir();
    const { params, options } = request();
    const refusal = refusalMessage();
    if (refusal.stop_details) refusal.stop_details.fallback_credit_token = "test-credit-token";
    await createRecordingClient(fakeClient([refusal]), dir).create(params, options);

    const stored = readFileSync(join(dir, `${requestKey(params)}.json`), "utf8");
    expect(stored).not.toContain("test-credit-token");
    const replayed = await createReplayClient(dir).create(params, options);
    expect(replayed.stop_details?.category).toBe("cyber");
    expect(replayed.stop_details?.fallback_credit_token).toBeNull();
  });

  it("drops thinking blocks from a fixture, since they can restate the input", async () => {
    const dir = freshDir();
    const { params, options } = request();
    const withThinking = okMessage({
      content: [
        { type: "thinking", thinking: "The snippet mentions Example Corp.", signature: "sig" },
        ...okMessage().content,
      ],
    } as Partial<BetaMessage>);
    await createRecordingClient(fakeClient([withThinking]), dir).create(params, options);

    const replayed = await createReplayClient(dir).create(params, options);
    expect(replayed.content).toEqual(okMessage().content);
  });

  it("uses a 64-character sha-256 hex key that ignores the timeout option", () => {
    const { params } = request();
    expect(requestKey(params)).toMatch(/^[0-9a-f]{64}$/);
    expect(requestKey(params)).toBe(requestKey(request().params));
  });
});
