import { z } from "zod";
import { waitedFor } from "./approvals";
import { safeHref } from "./handoffs";
import { APPLICATION_STATUSES, STATUS_WORDS } from "./pipeline";

// The unified job inbox (NS-165, INB-006): the API's answer and the plain words the page shows.
// Gmail ids, counts, steps and flags only: no subject, sender or body exists to show.

const Thread = z.object({
  gmailThreadId: z.string().regex(/^[0-9a-f]{1,32}$/),
  gmailUrl: z.string(),
  messages: z.number(),
  lastReceivedAt: z.string(),
  step: z.enum(["tag", "thread", "sender"]),
  senderVerified: z.boolean(),
  kind: z.string().nullable(),
});

const Application = z.object({
  applicationId: z.string(),
  jobTitle: z.string().nullable(),
  company: z.string().nullable(),
  status: z.enum(APPLICATION_STATUSES),
  startedBy: z.enum(["northstar", "outside", "recruiter_inbound"]).nullable(),
  submittedVia: z.enum(["auto", "approved", "handoff", "by_hand"]).nullable(),
  threads: z.array(Thread),
});
export type InboxApplicationView = z.infer<typeof Application>;

const Queued = z.object({
  gmailThreadId: z.string().regex(/^[0-9a-f]{1,32}$/),
  gmailUrl: z.string(),
  messages: z.number(),
  lastReceivedAt: z.string(),
  reason: z.enum(["unknown_tag", "ambiguous", "no_match"]),
});

export const InboxBody = z.object({ applications: z.array(Application), queued: z.array(Queued) });
export type InboxView = z.infer<typeof InboxBody>;

// The origin badge (INB-008): who started the application and how it went out.
export function originBadge(a: Pick<InboxApplicationView, "startedBy" | "submittedVia">): string {
  if (a.startedBy === null) return "Origin unknown";
  if (a.startedBy === "outside") return "Outside Northstar";
  if (a.startedBy === "recruiter_inbound") return "From a recruiter";
  if (a.submittedVia === "by_hand") return "Started by Northstar · you applied by hand";
  if (a.submittedVia === "auto") return "Started by Northstar · auto-approved";
  if (a.submittedVia === "approved") return "Started by Northstar · you approved";
  if (a.submittedVia === "handoff") return "Started by Northstar · you finished it";
  return "Started by Northstar";
}

// How a thread was tied to its application (NS-158's steps), in words.
const STEP_WORDS = {
  tag: "by its tagged address",
  thread: "by its thread",
  sender: "by the company's domain",
} as const;

// Why a thread waits for Paul (the confirm queue's reasons), in words.
const REASON_WORDS = {
  unknown_tag: "sent to a tagged address Northstar doesn't know",
  ambiguous: "could belong to more than one application",
  no_match: "doesn't match any application",
} as const;

export type ThreadRow = {
  key: string;
  // Null when the link isn't https to Gmail: the row then shows no link.
  href: string | null;
  messages: string;
  received: string;
  linked: string;
  // Shown only when no message's sender was verified (INB-011).
  unverified: boolean;
  kind: string;
};

const messages = (n: number) => `${n} ${n === 1 ? "message" : "messages"}`;
const received = (at: string, nowMs: number) => {
  const waited = waitedFor(at, nowMs);
  return waited === "just now" ? "last one just now" : `last one ${waited} ago`;
};
// Only an https link to Gmail itself: safeHref parses it, and the host must be exactly Gmail's.
const gmailHref = (url: string) => {
  const href = safeHref(url);
  return href !== null && new URL(href).hostname === "mail.google.com" ? href : null;
};

export function threadRows(a: InboxApplicationView, nowMs: number): ThreadRow[] {
  return a.threads.map((t) => ({
    key: t.gmailThreadId,
    href: gmailHref(t.gmailUrl),
    messages: messages(t.messages),
    received: received(t.lastReceivedAt, nowMs),
    linked: `Linked ${STEP_WORDS[t.step]}`,
    unverified: !t.senderVerified,
    // Classification arrives with the mail-link loop (#224).
    kind: t.kind === null ? "Not classified yet" : t.kind.replaceAll("_", " "),
  }));
}

export type QueuedRow = {
  key: string;
  href: string | null;
  messages: string;
  received: string;
  why: string;
};

export function queuedRows(queued: InboxView["queued"], nowMs: number): QueuedRow[] {
  return queued.map((q) => ({
    key: q.gmailThreadId,
    href: gmailHref(q.gmailUrl),
    messages: messages(q.messages),
    received: received(q.lastReceivedAt, nowMs),
    why: `This thread ${REASON_WORDS[q.reason]}`,
  }));
}

// "Backend Engineer at Example Corp", with plain fallbacks for a draft job.
export function applicationTitle(a: Pick<InboxApplicationView, "jobTitle" | "company">): string {
  const title = a.jobTitle ?? "Untitled job";
  return a.company ? `${title} at ${a.company}` : title;
}

export const statusWord = (a: Pick<InboxApplicationView, "status">) => STATUS_WORDS[a.status];
