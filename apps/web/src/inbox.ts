import { z } from "zod";
import { waitedFor } from "./approvals";
import { safeHref } from "./handoffs";
import { APPLICATION_STATUSES, STATUS_WORDS } from "./pipeline";

// The unified job inbox (NS-165, INB-006): the API's answer and the plain words the page shows.
// Gmail ids, counts, steps and flags only: no subject, sender or body exists to show.

// A recruiter grade (NS-238, REC-002): the letter, reason codes and confidence.
const Grade = z.object({
  grade: z.enum(["A", "B", "C", "D", "F"]),
  reasons: z.array(z.string()),
  confidence: z.enum(["normal", "low"]),
});
export type GradeView = z.infer<typeof Grade>;

const Thread = z.object({
  gmailThreadId: z.string().regex(/^[0-9a-f]{1,32}$/),
  gmailUrl: z.string(),
  messages: z.number(),
  lastReceivedAt: z.string(),
  step: z.enum(["tag", "thread", "sender"]),
  senderVerified: z.boolean(),
  kind: z.string().nullable(),
  recruiterGrade: Grade.optional(),
});

const Application = z.object({
  applicationId: z.uuid(),
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
  recruiterGrade: Grade.optional(),
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

// Each grade reason (gradeRecruiterMessage's codes) in words. An unknown code is left out, never
// shown raw.
export const GRADE_REASON_WORDS: Record<string, string> = {
  "title:exact": "the title matches",
  "title:partial": "the title partly matches",
  "title:none": "the title doesn't match",
  "title:unknown": "no title given",
  "title:level_mismatch": "a different level",
  "pay:ok": "pay meets your floor",
  "pay:below": "pay below your floor",
  "pay:unknown": "no pay given",
  "place:ok": "the place fits",
  "place:mismatch": "the place doesn't fit",
  "place:unknown": "no place given",
  "sender:agency": "an agency recruiter",
  "sender:in_house": "an in-house recruiter",
  "sender:unknown": "agency or in-house not stated",
  "personal:yes": "written for you",
  "personal:no": "not written for you",
  "company:named": "names the company",
  "company:unnamed": "doesn't name the company",
  dealbreaker: "hits one of your dealbreakers",
  "red_flag:upfront_fee": "asks for a fee",
  "red_flag:sensitive_data": "asks for sensitive data",
  "red_flag:vague_role": "the role is vague",
  "red_flag:unpaid_work": "asks for unpaid work",
};

// "Recruiter grade B: the title matches, no pay given", plus "(little to go on)" when two or more
// of title, pay and place were unknown (UX-014: every grade has a why).
export function gradeWords(g: GradeView): string {
  // Own keys only, so "constructor" or "toString" can't read the prototype.
  const why = g.reasons
    .flatMap((r) => (Object.hasOwn(GRADE_REASON_WORDS, r) ? [GRADE_REASON_WORDS[r] as string] : []))
    .join(", ");
  const low = g.confidence === "low" ? " (little to go on)" : "";
  return `Recruiter grade ${g.grade}${why ? `: ${why}` : ""}${low}`;
}

export type ThreadRow = {
  key: string;
  // Null when the link isn't https to Gmail: the row then shows no link.
  href: string | null;
  messages: string;
  received: string;
  linked: string;
  // "sender not verified" when no message's sender was verified (INB-011), else "".
  unverified: string;
  kind: string;
  // The recruiter grade in words (NS-238); absent when the thread has none.
  grade?: string;
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
    unverified: t.senderVerified ? "" : "sender not verified",
    // Classification arrives with the mail-link loop (#224).
    kind: t.kind === null ? "Not classified yet" : t.kind.replaceAll("_", " "),
    ...(t.recruiterGrade ? { grade: gradeWords(t.recruiterGrade) } : {}),
  }));
}

export type QueuedRow = {
  key: string;
  href: string | null;
  messages: string;
  received: string;
  why: string;
  grade?: string;
};

export function queuedRows(queued: InboxView["queued"], nowMs: number): QueuedRow[] {
  return queued.map((q) => ({
    key: q.gmailThreadId,
    href: gmailHref(q.gmailUrl),
    messages: messages(q.messages),
    received: received(q.lastReceivedAt, nowMs),
    why: `This thread ${REASON_WORDS[q.reason]}`,
    ...(q.recruiterGrade ? { grade: gradeWords(q.recruiterGrade) } : {}),
  }));
}

// "Backend Engineer at Example Corp", with plain fallbacks for a draft job.
export function applicationTitle(a: Pick<InboxApplicationView, "jobTitle" | "company">): string {
  const title = a.jobTitle ?? "Untitled job";
  return a.company ? `${title} at ${a.company}` : title;
}

export const statusWord = (a: Pick<InboxApplicationView, "status">) => STATUS_WORDS[a.status];
