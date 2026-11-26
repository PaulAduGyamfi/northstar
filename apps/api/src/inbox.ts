import type { Inbox } from "@northstar/db";
import { APPLICATION_STATUSES, STARTED_BY, SUBMITTED_VIA } from "@northstar/domain";
import { z } from "zod";
import { type AnyEndpoint, endpoint } from "./endpoint.js";

// The unified job inbox (NS-165, INB-006): Paul's linked job-mail threads grouped by application,
// and the threads waiting for him to link them. Read-only, session only. Gmail ids, steps, flags,
// counts and times: no subject, sender or body exists to show. bin.ts wires packages/db's read.

export type InboxPorts = { read: () => Promise<Inbox> };

// Gmail thread ids are hex (mail_link's CHECK). Only such an id goes into a link: anything else
// is dropped, so a bad row can never put another URL or markup on the page.
const GMAIL_ID = /^[0-9a-f]{1,32}$/;
const gmailUrl = (threadId: string) => `https://mail.google.com/mail/u/0/#all/${threadId}`;

// A recruiter grade (NS-238): codes only, checked again here so no text can reach the page.
const Grade = z.object({
  grade: z.enum(["A", "B", "C", "D", "F"]),
  reasons: z.array(z.string().regex(/^(dealbreaker|[a-z_]+:[a-z_]+)$/)).max(12),
  confidence: z.enum(["normal", "low"]),
});
type GradeView = z.infer<typeof Grade>;
// Only a graded thread carries the field, picked field by field.
const gradeOf = (g: { grade: string; reasons: string[]; confidence: string } | undefined) =>
  g === undefined
    ? {}
    : {
        recruiterGrade: {
          grade: g.grade as GradeView["grade"],
          reasons: g.reasons,
          confidence: g.confidence as GradeView["confidence"],
        },
      };

const Thread = z.object({
  gmailThreadId: z.string().regex(GMAIL_ID),
  gmailUrl: z.url({ protocol: /^https$/ }),
  messages: z.number().int().positive(),
  lastReceivedAt: z.string(),
  step: z.enum(["tag", "thread", "sender"]),
  senderVerified: z.boolean(),
  kind: z.string().nullable(),
  recruiterGrade: Grade.optional(),
});

const Application = z.object({
  // A database id, checked because the page puts it into a link to the application.
  applicationId: z.uuid(),
  jobTitle: z.string().nullable(),
  company: z.string().nullable(),
  status: z.enum(APPLICATION_STATUSES),
  startedBy: z.enum(STARTED_BY).nullable(),
  submittedVia: z.enum(SUBMITTED_VIA).nullable(),
  threads: z.array(Thread),
});

const Queued = z.object({
  gmailThreadId: z.string().regex(GMAIL_ID),
  gmailUrl: z.url({ protocol: /^https$/ }),
  messages: z.number().int().positive(),
  lastReceivedAt: z.string(),
  reason: z.enum(["unknown_tag", "ambiguous", "no_match"]),
  recruiterGrade: Grade.optional(),
});

export function inboxEndpoints(ports: InboxPorts): AnyEndpoint[] {
  const read = endpoint({
    method: "GET",
    path: "/inbox",
    auth: "session",
    input: z.object({}),
    output: z.object({ applications: z.array(Application), queued: z.array(Queued) }),
    handler: async () => {
      let inbox: Inbox;
      try {
        inbox = await ports.read();
      } catch {
        // The inbox can't be read (Postgres down): the page says so.
        return { ok: false, status: 503, error: "unavailable" };
      }
      // Built field by field, so nothing the read adds later leaks out.
      const applications = inbox.applications.map((a) => ({
        applicationId: a.applicationId,
        jobTitle: a.jobTitle,
        company: a.company,
        status: a.status,
        startedBy: a.origin.startedBy,
        submittedVia: a.origin.submittedVia,
        threads: a.threads
          .filter((t) => GMAIL_ID.test(t.gmailThreadId))
          .map((t) => ({
            gmailThreadId: t.gmailThreadId,
            gmailUrl: gmailUrl(t.gmailThreadId),
            messages: t.messages,
            lastReceivedAt: t.lastReceivedAt.toISOString(),
            step: t.step,
            senderVerified: t.senderVerified,
            kind: t.kind,
            ...gradeOf(t.recruiterGrade),
          })),
      }));
      const queued = inbox.queued
        .filter((q) => GMAIL_ID.test(q.gmailThreadId))
        .map((q) => ({
          gmailThreadId: q.gmailThreadId,
          gmailUrl: gmailUrl(q.gmailThreadId),
          messages: q.messages,
          lastReceivedAt: q.lastReceivedAt.toISOString(),
          reason: q.reason,
          ...gradeOf(q.recruiterGrade),
        }));
      return { ok: true, body: { applications, queued } };
    },
  });
  return [read];
}
