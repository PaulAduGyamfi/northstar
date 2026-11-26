// Public entry of @northstar/llm: the only package that talks to Claude (ADR-0006, ADR-0013).
export { anthropicClientOptions, createAnthropicClient } from "./anthropic-client.js";
// The LLM spend cap (NS-176, ADR-0021).
export {
  budgetHold,
  HOLD_AT,
  type LlmBudget,
  loadLlmBudget,
  pausedPriorities,
  type RoutePriority,
  type SpendMeter,
  type Spent,
} from "./budget.js";
export type { MessagesClient } from "./client.js";
export { type LlmConfig, loadLlmConfig } from "./config.js";
export { LlmTransportError } from "./errors.js";
export {
  canonicalJson,
  createRecordingClient,
  createReplayClient,
  MissingFixture,
  requestKey,
} from "./fixtures.js";
export {
  ANTHROPIC_DEPENDENCY,
  agentSwitch,
  createLlmGateway,
  type LlmGateway,
} from "./gateway.js";
export {
  type Admission,
  admit,
  type CallGuard,
  describeHeldBack,
  type GuardDecision,
  type GuardOutcome,
  HeldBack,
  type HeldBy,
} from "./guard.js";
export type { CallRecord, LlmOutcome } from "./outcome.js";
export { costUsd, type TokenUsage } from "./pricing.js";
export { DEFAULT_MODEL, type Effort, type Route } from "./route.js";
export { untrustedBlock } from "./untrusted.js";
