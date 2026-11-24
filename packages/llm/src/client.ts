import type { BetaMessage, MessageCreateParams, RequestOptions } from "./sdk-types.js";

// The one SDK method the gateway needs. The real client, the replay client, the recording
// client and the test fake all implement it.
export type MessagesClient = {
  create(params: MessageCreateParams, options?: RequestOptions): Promise<BetaMessage>;
};
