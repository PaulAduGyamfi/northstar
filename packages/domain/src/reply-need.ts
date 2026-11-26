import type { MailKind } from "./mail-status.js";

// Whether a job email needs a reply from Paul (RPL-001, NS-166). Plain code: the model only says
// what kind of message it is; this decides whether a reply is drafted at all.
//   reply: draft one.
//   reply_without_times: draft one that proposes no times, since real free slots need Calendar
//     (RPL-003, NS-169), which doesn't exist yet.
//   none: nothing to answer (a confirmation, rejection or note), or Paul answers it himself (an
//     offer), or the kind is unknown.
export type ReplyNeed = "reply" | "reply_without_times" | "none";

const NEEDS: Record<MailKind, ReplyNeed> = {
  recruiter_inbound: "reply",
  assessment: "reply",
  follow_up_needed: "reply",
  interview_request: "reply_without_times",
  scheduling: "reply_without_times",
  confirmation: "none",
  rejection: "none",
  offer: "none",
  info_other: "none",
};

export function replyNeed(kind: string): ReplyNeed {
  // Own keys only, so "constructor" or "toString" can't read the prototype.
  return Object.hasOwn(NEEDS, kind) ? NEEDS[kind as MailKind] : "none";
}
