import {
  type InboundHeaders,
  type InvalidReply,
  parseReplyPackage,
  type ReplyPackage,
  type Result,
  replyEnvelope,
} from "@northstar/domain";
import type { ReplyDraft } from "./schema.js";
import { replyText } from "./validate.js";

// A checked reply draft as the package the Gate files (NS-237, RPL-002): plain code, no model. The
// envelope comes only from the incoming message's own headers (replyEnvelope), the body from the
// checked sentences, and the cites from what those sentences quote. Call it only with a draft
// draftReply returned as `drafted`, which validateReplyDraft passed.
export function replyPackage(input: {
  gmailMessageId: string;
  threadId: string;
  inbound: InboundHeaders;
  draft: ReplyDraft;
}): Result<ReplyPackage, InvalidReply> {
  const envelope = replyEnvelope(input.inbound);
  if (!envelope.ok) return envelope;
  // Each cited story or atom once, in the order the draft first cites it.
  const cites = [...new Set(input.draft.sentences.flatMap((s) => s.cites.map((c) => c.id)))];
  return parseReplyPackage({
    gmailMessageId: input.gmailMessageId,
    threadId: input.threadId,
    envelope: envelope.value,
    body: replyText(input.draft),
    cites,
    followUps: input.draft.followUps,
  });
}
