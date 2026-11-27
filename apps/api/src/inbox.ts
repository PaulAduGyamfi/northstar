import type {
  Inbox,
  LinkTarget,
  QueueDecision,
  QueueDecisionError,
  RegradeError,
} from "@northstar/db";
import {
  APPLICATION_STATUSES,
  RECRUITER_GRADE_REASONS,
  STARTED_BY,
  SUBMITTED_VIA,
} from "@northstar/domain";
import { z } from "zod";
import { type AnyEndpoint, endpoint } from "./endpoint.js";

// The unified job inbox (NS-165, INB-006): Paul's linked job-mail threads grouped by application,
// and the threads waiting for him to link them. Session only. Gmail ids, steps, flags, counts and
// times: no subject, sender or body exists to show. Since NS-262 Paul links a queued thread to one
// of his open applications, or dismisses it (POST /inbox/decide). bin.ts wires packages/db.

export type InboxPorts = {
  read: () => Promise<Inbox>;
  // The open applications a queued thread can be linked to (readLinkTargets).
  targets: () => Promise<LinkTarget[]>;
  decide: (input: {
    gmailThreadId: string;
    decision: QueueDecision;
  }) => Promise<
    { ok: true; value: { recorded: number } } | { ok: false; error: QueueDecisionError }
  >;
  // Paul's own letter for a graded thread's newest graded message (NS-238 item 3, regradeThread).
  regrade?: (input: {
    gmailThreadId: string;
    // The row's application; absent for the confirm queue's row.
    applicationId?: string;
    grade: string;
  }) => Promise<{ ok: true; value: { recorded: boolean } } | { ok: false; error: RegradeError }>;
};

// Gmail thread ids are hex (mail_link's CHECK). Only such an id goes into a link: anything else
// is dropped, so a bad row can never put another URL or markup on the page.
const GMAIL_ID = /^[0-9a-f]{1,32}$/;
const gmailUrl = (threadId: string) => `https://mail.google.com/mail/u/0/#all/${threadId}`;

// A recruiter grade (NS-238): codes only, checked again here so no text can reach the page.
const Grade = z.object({
  grade: z.enum(["A", "B", "C", "D", "F"]),
  reasons: z.array(z.enum(RECRUITER_GRADE_REASONS)).max(12),
  confidence: z.enum(["normal", "low"]),
  // Paul's own letter (NS-238 item 3), absent until he regrades.
  paulGrade: z.enum(["A", "B", "C", "D", "F"]).optional(),
});
type GradeView = z.infer<typeof Grade>;
// Only a graded thread carries the field, picked field by field.
const gradeOf = (
  g: { grade: string; reasons: string[]; confidence: string; paulGrade?: string } | undefined,
) =>
  g === undefined
    ? {}
    : {
        recruiterGrade: {
          grade: g.grade as GradeView["grade"],
          reasons: g.reasons as GradeView["reasons"],
          confidence: g.confidence as GradeView["confidence"],
          ...(g.paulGrade === undefined
            ? {}
            : { paulGrade: g.paulGrade as NonNullable<GradeView["paulGrade"]> }),
        },
      };

const Thread = z.object({
  gmailThreadId: z.string().regex(GMAIL_ID),
  gmailUrl: z.url({ protocol: /^https$/ }),
  messages: z.number().int().positive(),
  lastReceivedAt: z.string(),
  // `paul`: he linked it from the confirm queue (NS-262).
  step: z.enum(["tag", "thread", "sender", "paul"]),
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

const Target = z.object({
  // A database id, checked because the page sends it back as the link's application.
  applicationId: z.uuid(),
  jobTitle: z.string().nullable(),
  company: z.string().nullable(),
});

const Decide = z
  .object({
    gmailThreadId: z.string().regex(GMAIL_ID),
    decision: z.enum(["link", "dismiss"]),
    applicationId: z.uuid().optional(),
  })
  // A link names its application; a dismiss names none.
  .refine((d) => (d.decision === "link") === (d.applicationId !== undefined), {
    path: ["applicationId"],
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

  // The open applications a queued thread can be linked to (NS-262), for the queue's choice.
  const targets = endpoint({
    method: "GET",
    path: "/inbox/link-targets",
    auth: "session",
    input: z.object({}),
    output: z.object({ items: z.array(Target) }),
    handler: async () => {
      let rows: LinkTarget[];
      try {
        rows = await ports.targets();
      } catch {
        return { ok: false, status: 503, error: "unavailable" };
      }
      // Field by field, so nothing the read adds later leaks out.
      const items = rows.map((t) => ({
        applicationId: t.applicationId,
        jobTitle: t.jobTitle,
        company: t.company,
      }));
      return { ok: true, body: { items } };
    },
  });

  const decide = endpoint({
    method: "POST",
    path: "/inbox/decide",
    auth: "session",
    input: Decide,
    output: z.object({ decision: z.enum(["link", "dismiss"]), recorded: z.number().int() }),
    handler: async ({ gmailThreadId, decision, applicationId }) => {
      try {
        // Only Paul's signed-in path reaches this; the write records it as his.
        const r = await ports.decide({
          gmailThreadId,
          decision:
            decision === "link" && applicationId !== undefined
              ? { kind: "link", applicationId }
              : { kind: "dismiss" },
        });
        if (r.ok) return { ok: true, body: { decision, recorded: r.value.recorded } };
        if (r.error.kind === "NotFound") return { ok: false, status: 404, error: "not_found" };
        if (r.error.kind === "UnknownApplication") {
          return { ok: false, status: 404, error: "unknown_application" };
        }
        if (r.error.kind === "ApplicationClosed") {
          return { ok: false, status: 409, error: "application_closed" };
        }
        return { ok: false, status: 400, error: "invalid_input" };
      } catch {
        return { ok: false, status: 503, error: "unavailable" };
      }
    },
  });
  const regrade = endpoint({
    method: "POST",
    path: "/inbox/regrade",
    auth: "session",
    input: z.object({
      gmailThreadId: z.string().regex(GMAIL_ID),
      // The Inbox row's application; absent for a thread in the confirm queue.
      applicationId: z.uuid().optional(),
      grade: z.enum(["A", "B", "C", "D", "F"]),
    }),
    output: z.object({ grade: z.enum(["A", "B", "C", "D", "F"]), recorded: z.boolean() }),
    handler: async ({ gmailThreadId, applicationId, grade }) => {
      if (!ports.regrade) return { ok: false, status: 503, error: "unavailable" };
      try {
        // Only Paul's signed-in path reaches this; the write records it as his.
        const r = await ports.regrade({
          gmailThreadId,
          grade,
          ...(applicationId === undefined ? {} : { applicationId }),
        });
        if (r.ok) return { ok: true, body: { grade, recorded: r.value.recorded } };
        if (r.error.kind === "NotGraded") return { ok: false, status: 404, error: "not_graded" };
        return { ok: false, status: 400, error: "invalid_input" };
      } catch {
        return { ok: false, status: 503, error: "unavailable" };
      }
    },
  });
  return [read, targets, decide, regrade];
}
