import type { MessagesClient } from "../client.js";
import type { BetaMessage, MessageCreateParams, RequestOptions } from "../sdk-types.js";

// A MessagesClient that records each request and answers from a queue of canned responses or
// errors. Never touches the network.
export function fakeClient(answers: Array<BetaMessage | Error>): MessagesClient & {
  requests: Array<{ params: MessageCreateParams; options: RequestOptions | undefined }>;
} {
  const requests: Array<{ params: MessageCreateParams; options: RequestOptions | undefined }> = [];
  return {
    requests,
    async create(params, options) {
      requests.push({ params, options });
      const next = answers.shift();
      if (!next) throw new Error("fakeClient: no answer queued");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}
