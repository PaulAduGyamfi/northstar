import {
  type InboundHeaders,
  type InvalidReply,
  parseReplyPackage,
  type ReplyPackage,
  type Result,
  replyEnvelope,
  replyToOtherDomain,
} from "@northstar/domain";
import type { ReplyResult } from "./draft.js";
import { replyText } from "./validate.js";

// A checked reply draft as the package the Gate files (NS-237, RPL-002): plain code, no model. The
// envelope comes only from the incoming message's own headers (replyEnvelope), the body from the
// checked sentences, and the cites from what those sentences quote. It takes only draftReply's
// `drafted` result, which validateReplyDraft passed (ADR-0004), so an unchecked draft can't be
// packaged.
export function replyPackage(input: {
  gmailMessageId: string;
  threadId: string;
  inbound: InboundHeaders;
  drafted: Extract<ReplyResult, { kind: "drafted" }>;
}): Result<ReplyPackage, InvalidReply> {
  const envelope = replyEnvelope(input.inbound);
  if (!envelope.ok) return envelope;
  const draft = input.drafted.draft;
  // Each cited story or atom once, in the order the draft first cites it.
  const cites = [...new Set(draft.sentences.flatMap((s) => s.cites.map((c) => c.id)))];
  return parseReplyPackage({
    gmailMessageId: input.gmailMessageId,
    threadId: input.threadId,
    envelope: envelope.value,
    replyToOtherDomain: replyToOtherDomain(input.inbound),
    body: replyText(draft),
    cites,
    followUps: draft.followUps,
  });
}
