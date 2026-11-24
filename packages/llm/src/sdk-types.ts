// The SDK types the gateway uses, imported in one place so the rest of the package doesn't
// depend on the SDK's file layout.

export type {
  BetaMessage,
  BetaUsage,
  MessageCreateParamsNonStreaming as MessageCreateParams,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

// The only request option the gateway sets: the per-route timeout in milliseconds.
export type RequestOptions = { timeout: number };
