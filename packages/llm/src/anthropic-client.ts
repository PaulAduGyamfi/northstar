import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import type { MessagesClient } from "./client.js";
import type { LlmConfig } from "./config.js";

// Options for the real SDK client. Content mode is set in code on purpose: an option set in
// code replaces the SDK's environment variables, so nobody can switch on exporting prompts and
// replies (resume text, emails) into traces from the environment (ADR-0013).
export function anthropicClientOptions(config: LlmConfig): ClientOptions {
  return {
    apiKey: config.apiKey,
    openTelemetry: { traces: { contentMode: "metadata_only" } },
    // Same reason: ANTHROPIC_LOG=debug would log request and response bodies.
    logLevel: "warn",
    // Explicit, not the SDK default: a route's timeout applies to each attempt, so the worst
    // case is (maxRetries + 1) × timeoutMs plus backoff (RES-005).
    maxRetries: 2,
  };
}

// The real MessagesClient: the SDK's beta Messages endpoint (needed for `fallbacks`).
// Only entry points (workers, the eval CLI in --live mode) construct it.
export function createAnthropicClient(config: LlmConfig): MessagesClient {
  const anthropic = new Anthropic(anthropicClientOptions(config));
  return { create: (params, options) => anthropic.beta.messages.create(params, options) };
}
