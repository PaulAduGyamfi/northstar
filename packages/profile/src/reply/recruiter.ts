import {
  type InboundHeaders,
  type InvalidReply,
  parseReplyPackage,
  type ReplyPackage,
  type Result,
  replyEnvelope,
  replyToOtherDomain,
} from "@northstar/domain";
import { displayName, isNoReplyAddress, type NoReplyAddress } from "./nudge.js";
import { greetingName } from "./validate.js";

// A reply to a graded recruiter email as the reply package the Gate files (REC-002, NS-238
// slice 2): plain code, no model, built like a follow-up nudge. The body is fixed text per kind
// that states no fact, figure, time, link, name (beyond the sender's checked first name) or
// commitment, so there's nothing to cite and nothing to invent (ADR-0004). fileReplyDraft files it
// as an `email_reply` for Paul's approval; nothing is sent (ADR-0002).

// The grade letters gradeRecruiterMessage gives (packages/sources) and recruiter_grade stores.
export type RecruiterGradeLetter = "A" | "B" | "C" | "D" | "F";
export type RecruiterReplyKind = "interested" | "more_info" | "decline" | "archive";

// REC-002: A or B is worth a conversation, C needs more facts first, D is a polite no. An F has a
// dealbreaker, an upfront fee or a request for sensitive data: replying confirms the address to a
// possible scammer, so the suggestion is to archive it and no reply is drafted.
export function recruiterReplyKind(grade: RecruiterGradeLetter): RecruiterReplyKind {
  if (grade === "A" || grade === "B") return "interested";
  if (grade === "C") return "more_info";
  return grade === "D" ? "decline" : "archive";
}

// One sentence per kind that gets a reply. None uses a commitment word (isCommitmentWord: so no
// "decline", "pay", "start" or "available"), a number or a link (a test checks).
export const RECRUITER_REPLY_SENTENCES: Record<Exclude<RecruiterReplyKind, "archive">, string> = {
  interested: "I'm interested in this role and would be glad to learn more about it.",
  more_info: "Could you share more about the role, the team and the company?",
  decline: "This role isn't the right fit for me right now, but I appreciate you thinking of me.",
};

export type ArchiveSuggested = { kind: "ArchiveSuggested" };

// The reply's whole body: a greeting (the sender's first name only when greetingName accepts it),
// a thank-you and the kind's sentence.
export function recruiterReplyBody(
  kind: Exclude<RecruiterReplyKind, "archive">,
  senderName: string | null,
): string {
  const name = greetingName(senderName);
  const greeting = name === null ? "Hi," : `Hi ${name},`;
  return `${greeting} Thank you for reaching out. ${RECRUITER_REPLY_SENTENCES[kind]}`;
}

export function recruiterReplyPackage(input: {
  gmailMessageId: string;
  threadId: string;
  inbound: InboundHeaders;
  grade: RecruiterGradeLetter;
}): Result<ReplyPackage, InvalidReply | NoReplyAddress | ArchiveSuggested> {
  const kind = recruiterReplyKind(input.grade);
  // Before the envelope: an F gets no reply whatever its headers say.
  if (kind === "archive") return { ok: false, error: { kind: "ArchiveSuggested" } };
  const envelope = replyEnvelope(input.inbound);
  if (!envelope.ok) return envelope;
  if (isNoReplyAddress(envelope.value.to)) return { ok: false, error: { kind: "NoReplyAddress" } };
  // The From header's own name, never one the caller passes; none when a Reply-To redirects it.
  const from = input.inbound.from;
  const senderName = input.inbound.replyTo === null && from !== null ? displayName(from) : null;
  return parseReplyPackage({
    gmailMessageId: input.gmailMessageId,
    threadId: input.threadId,
    envelope: envelope.value,
    replyToOtherDomain: replyToOtherDomain(input.inbound),
    body: recruiterReplyBody(kind, senderName),
    cites: [],
    followUps: [],
  });
}
