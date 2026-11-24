import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { anthropicClientOptions } from "./anthropic-client.js";

const CONTENT_MODE_ENV = "ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE";

const LOG_ENV = "ANTHROPIC_LOG";

afterEach(() => {
  delete process.env[CONTENT_MODE_ENV];
  delete process.env[LOG_ENV];
});

describe("anthropic client options", () => {
  it("pins the SDK's spans to metadata only", () => {
    expect(anthropicClientOptions({ apiKey: "test-key" }).openTelemetry).toEqual({
      traces: { contentMode: "metadata_only" },
    });
  });

  it("sets the SDK's retry count explicitly, so the worst-case wait is known", () => {
    expect(anthropicClientOptions({ apiKey: "test-key" }).maxRetries).toBe(2);
  });

  it("keeps SDK logging at warn even when the environment asks for debug", () => {
    // Debug logging prints request and response bodies (resumes, emails).
    process.env[LOG_ENV] = "debug";
    const client = new Anthropic(anthropicClientOptions({ apiKey: "test-key" }));
    expect(client.logLevel).toBe("warn");
  });

  it("keeps spans metadata-only even when the environment asks for content", () => {
    // Someone sets the SDK's env var to export prompts; the pinned option must win.
    process.env[CONTENT_MODE_ENV] = "content";
    const client = new Anthropic(anthropicClientOptions({ apiKey: "test-key" }));
    expect(client.openTelemetry).toMatchObject({ traces: { contentMode: "metadata_only" } });
  });
});
