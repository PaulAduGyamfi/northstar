import type { BetaMessage } from "../sdk-types.js";

// Synthetic API responses in the shape of the Messages API (not recordings of real calls).
// Tests change one field at a time from `okMessage`.

const usage = {
  input_tokens: 1200,
  output_tokens: 300,
  cache_read_input_tokens: 4000,
  cache_creation_input_tokens: 0,
  iterations: null,
};

export function okMessage(overrides: Partial<BetaMessage> = {}): BetaMessage {
  return {
    id: "msg_test_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: '{"label":"remote","confidence":0.9}', citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage,
    ...overrides,
  } as BetaMessage;
}

export function refusalMessage(): BetaMessage {
  return okMessage({
    content: [],
    stop_reason: "refusal",
    stop_details: {
      type: "refusal",
      category: "cyber",
      explanation: "Synthetic refusal.",
      fallback_credit_token: null,
      fallback_has_prefill_claim: null,
      recommended_model: null,
    },
  } as Partial<BetaMessage>);
}

export function truncatedMessage(): BetaMessage {
  return okMessage({
    content: [{ type: "text", text: '{"label":"rem', citations: null }],
    stop_reason: "max_tokens",
  } as Partial<BetaMessage>);
}

export function fallbackMessage(): BetaMessage {
  return okMessage({
    model: "claude-sonnet-5-5",
    usage: {
      ...usage,
      iterations: [
        {
          type: "fallback_message",
          model: "claude-sonnet-5-5",
          input_tokens: 1200,
          output_tokens: 300,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_creation: null,
        },
      ],
    },
  } as Partial<BetaMessage>);
}
