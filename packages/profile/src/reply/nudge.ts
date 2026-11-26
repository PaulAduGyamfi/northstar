import {
  type InboundHeaders,
  type InvalidReply,
  type NudgeStage,
  parseReplyPackage,
  type ReplyPackage,
  type Result,
  replyEnvelope,
  replyToOtherDomain,
} from "@northstar/domain";
import { greetingName } from "./validate.js";

// A follow-up nudge as the reply package the Gate files (RPL-004, NS-237 slice 3): plain code, no
// model. The body is fixed text per stage that states no fact, figure, time, name (beyond the
// sender's checked first name) or commitment, so there's nothing to cite and nothing to invent
// (ADR-0004). The envelope comes from the message being replied on, exactly as for a reply, and
// fileReplyDraft files it as an `email_reply` for Paul's approval (ADR-0002).

// The one follow-up sentence per stage. Neither claims an interview took place or names a role.
export const NUDGE_SENTENCES: Record<NudgeStage, string> = {
  applied: "I'm following up on my application and would be glad to hear about next steps.",
  interview:
    "I'm following up on where things stand in the process and would be glad to hear about next steps.",
};

// The nudge's whole body: a greeting (the sender's first name only when greetingName accepts it),
// the stage's sentence and a thank-you.
export function nudgeBody(stage: NudgeStage, senderName: string | null): string {
  const name = greetingName(senderName);
  return `${name === null ? "Hi," : `Hi ${name},`} ${NUDGE_SENTENCES[stage]} Thank you.`;
}

export function nudgePackage(input: {
  gmailMessageId: string;
  threadId: string;
  inbound: InboundHeaders;
  senderName: string | null;
  stage: NudgeStage;
}): Result<ReplyPackage, InvalidReply> {
  const envelope = replyEnvelope(input.inbound);
  if (!envelope.ok) return envelope;
  return parseReplyPackage({
    gmailMessageId: input.gmailMessageId,
    threadId: input.threadId,
    envelope: envelope.value,
    replyToOtherDomain: replyToOtherDomain(input.inbound),
    body: nudgeBody(input.stage, input.senderName),
    cites: [],
    followUps: [],
  });
}
