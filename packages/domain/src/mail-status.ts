import { type ApplicationStatus, nextStatus } from "./application-status.js";

// What a linked job email does to its application's status (NS-164, INB-004 P2, INB-011). Plain
// code: the model only says what kind of message it is; this decides whether that moves the
// status, and whether the move happens by itself or waits for Paul.

// INB-003's message kinds: the same list as MAIL_KINDS in @northstar/inbox. A test in
// packages/funnel proves they match, since neither package depends on the other.
export type MailKind =
  | "confirmation"
  | "rejection"
  | "assessment"
  | "interview_request"
  | "scheduling"
  | "recruiter_inbound"
  | "follow_up_needed"
  | "offer"
  | "info_other";

// How the message was tied to the application. deterministic: a tag, an already-linked thread or
// the application's own company domain picked exactly one application (matchMail's "linked"); a
// link Paul confirmed from the queue is not. senderVerified: a DMARC or aligned DKIM pass for the
// application's company or ATS domains (matchMail's senderVerified).
export type MailLink = { deterministic: boolean; senderVerified: boolean };

export type MailStatusChange =
  // Both INB-011 conditions hold: the status moves by itself.
  | { action: "apply"; to: ApplicationStatus }
  // The move is legal but unproven: it waits in the confirm queue for Paul.
  | {
      action: "propose";
      to: ApplicationStatus;
      reason: "link_not_deterministic" | "sender_not_verified";
    }
  // no_status: the kind says nothing about the status. same: it already has it. not_a_move: the
  // state machine doesn't allow it (backwards, after a terminal status, or before submission).
  | { action: "none"; reason: "no_status" | "same" | "not_a_move" };

// The status each kind points to. A scheduling or assessment mail means the process is under way;
// recruiter mail, follow-up reminders and everything else say nothing about the status.
const TARGET: Readonly<Record<MailKind, ApplicationStatus | null>> = {
  confirmation: "confirmed",
  rejection: "rejected",
  assessment: "in_process",
  interview_request: "in_process",
  scheduling: "in_process",
  offer: "offer",
  recruiter_inbound: null,
  follow_up_needed: null,
  info_other: null,
};

// The kinds this module knows, for the test in packages/funnel that compares them with the
// inbox's MAIL_KINDS.
export const MAIL_STATUS_KINDS = Object.keys(TARGET) as MailKind[];

export function mailStatusChange(input: {
  kind: MailKind;
  current: ApplicationStatus;
  link: MailLink;
}): MailStatusChange {
  const to = TARGET[input.kind];
  if (to === null) return { action: "none", reason: "no_status" };
  if (to === input.current) return { action: "none", reason: "same" };
  // Only moves the state machine allows: a late confirmation never pulls an application back
  // from in_process, and nothing moves one that was never submitted.
  if (!nextStatus(input.current, to).ok) return { action: "none", reason: "not_a_move" };
  // INB-011: a tag or a thread says which application, not who wrote the mail.
  if (!input.link.deterministic) {
    return { action: "propose", to, reason: "link_not_deterministic" };
  }
  if (!input.link.senderVerified) return { action: "propose", to, reason: "sender_not_verified" };
  return { action: "apply", to };
}
