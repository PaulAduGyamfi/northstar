import type { ApplicationStatus, CandidateId } from "@northstar/domain";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { type MATCH_STEPS, mailLink, type QUEUE_REASONS } from "./mail-link-schema.js";
import { type Origin, readOrigins } from "./origin-write.js";
import { recruiterGrade } from "./recruiter-grade-schema.js";
import { inSpan } from "./resilience-event.js";
import { application, company, job } from "./schema.js";

// The unified job inbox (NS-165, INB-006): linked mail threads grouped by application, and the
// threads waiting for Paul to link them. Read-only, from mail_link: Gmail ids, steps, flags and
// times only. Subjects, senders and bodies are never stored, so they can't appear here.

export type InboxThread = {
  gmailThreadId: string;
  messages: number;
  lastReceivedAt: Date;
  // How the newest message was linked.
  step: (typeof MATCH_STEPS)[number];
  // Any message's sender was verified for this application (INB-011).
  senderVerified: boolean;
  // The mail's kind once the mail-link loop stores classifications (#224); null until then.
  kind: string | null;
  // The newest graded message's recruiter grade (NS-238); absent when none is graded.
  recruiterGrade?: ThreadGrade;
};

// A recruiter grade as the inbox shows it: codes only, never email text.
export type ThreadGrade = { grade: string; reasons: string[]; confidence: string };

export type InboxApplication = {
  applicationId: string;
  jobTitle: string | null;
  company: string | null;
  status: ApplicationStatus;
  origin: Origin;
  threads: InboxThread[];
};

export type QueuedThread = {
  gmailThreadId: string;
  messages: number;
  lastReceivedAt: Date;
  // Why the newest message couldn't be linked.
  reason: (typeof QUEUE_REASONS)[number];
  recruiterGrade?: ThreadGrade;
};

// A thread with some messages linked and others queued shows up in both groups, each counting
// only its own messages: a later mail in a linked thread can still fail to match on its own.
export type Inbox = { applications: InboxApplication[]; queued: QueuedThread[] };

// More threads than this are cut, newest kept: far above a year of job mail.
export const MAX_INBOX_THREADS = 1000;

const NO_ORIGIN: Origin = { startedBy: null, submittedVia: null };

export async function readInboxThreads(db: Db, candidateId: CandidateId): Promise<Inbox> {
  return inSpan("db.inbox.read", {}, async (span) => {
    const lastReceived = sql<Date>`max(${mailLink.receivedAt})`;
    const linked = await db
      .select({
        applicationId: mailLink.applicationId,
        gmailThreadId: mailLink.gmailThreadId,
        messages: sql<number>`count(*)::int`,
        lastReceivedAt: lastReceived,
        step: sql<string>`(array_agg(${mailLink.step} order by ${mailLink.receivedAt} desc))[1]`,
        senderVerified: sql<boolean>`bool_or(${mailLink.senderVerified})`,
        jobTitle: job.title,
        company: company.name,
        status: application.status,
      })
      .from(mailLink)
      .innerJoin(
        application,
        and(
          eq(application.id, mailLink.applicationId),
          eq(application.candidateId, mailLink.candidateId),
        ),
      )
      .innerJoin(job, eq(job.id, application.jobId))
      .leftJoin(company, eq(company.id, job.companyId))
      .where(and(eq(mailLink.candidateId, candidateId), isNotNull(mailLink.applicationId)))
      .groupBy(
        mailLink.applicationId,
        mailLink.gmailThreadId,
        job.title,
        company.name,
        application.status,
      )
      .orderBy(desc(lastReceived), mailLink.gmailThreadId)
      .limit(MAX_INBOX_THREADS);
    const queued = await db
      .select({
        gmailThreadId: mailLink.gmailThreadId,
        messages: sql<number>`count(*)::int`,
        lastReceivedAt: lastReceived,
        reason: sql<string>`(array_agg(${mailLink.queueReason} order by ${mailLink.receivedAt} desc))[1]`,
      })
      .from(mailLink)
      .where(and(eq(mailLink.candidateId, candidateId), isNull(mailLink.applicationId)))
      .groupBy(mailLink.gmailThreadId)
      .orderBy(desc(lastReceived), mailLink.gmailThreadId)
      .limit(MAX_INBOX_THREADS);
    const origins = await readOrigins(db, candidateId);
    // Each thread's newest graded message, keyed by thread and application (null: queued), newest
    // first so the first row seen per key wins.
    const grades = new Map<string, ThreadGrade>();
    const gradeRows = await db
      .select({
        gmailThreadId: mailLink.gmailThreadId,
        applicationId: mailLink.applicationId,
        grade: recruiterGrade.grade,
        reasons: recruiterGrade.reasons,
        confidence: recruiterGrade.confidence,
      })
      .from(recruiterGrade)
      .innerJoin(
        mailLink,
        and(
          eq(mailLink.candidateId, recruiterGrade.candidateId),
          eq(mailLink.gmailMessageId, recruiterGrade.gmailMessageId),
        ),
      )
      .where(eq(recruiterGrade.candidateId, candidateId))
      .orderBy(desc(mailLink.receivedAt), desc(mailLink.gmailMessageId));
    for (const g of gradeRows) {
      const key = `${g.gmailThreadId}:${g.applicationId ?? ""}`;
      if (!grades.has(key)) {
        grades.set(key, { grade: g.grade, reasons: g.reasons, confidence: g.confidence });
      }
    }

    // Only a graded thread carries the field.
    const gradeOf = (key: string) => {
      const g = grades.get(key);
      return g === undefined ? {} : { recruiterGrade: g };
    };

    // Rows come newest first, so each application's first thread sets its place in the list.
    const apps = new Map<string, InboxApplication>();
    for (const r of linked) {
      const id = r.applicationId as string;
      let app = apps.get(id);
      if (!app) {
        app = {
          applicationId: id,
          jobTitle: r.jobTitle,
          company: r.company,
          status: r.status as ApplicationStatus,
          origin: origins.get(id) ?? NO_ORIGIN,
          threads: [],
        };
        apps.set(id, app);
      }
      app.threads.push({
        gmailThreadId: r.gmailThreadId,
        messages: r.messages,
        lastReceivedAt: new Date(r.lastReceivedAt),
        step: r.step as InboxThread["step"],
        senderVerified: r.senderVerified,
        kind: null,
        ...gradeOf(`${r.gmailThreadId}:${id}`),
      });
    }
    span.setAttributes({
      "northstar.inbox.applications": apps.size,
      "northstar.inbox.queued": queued.length,
    });
    return {
      applications: [...apps.values()],
      queued: queued.map((r) => ({
        gmailThreadId: r.gmailThreadId,
        messages: r.messages,
        lastReceivedAt: new Date(r.lastReceivedAt),
        reason: r.reason as QueuedThread["reason"],
        ...gradeOf(`${r.gmailThreadId}:`),
      })),
    };
  });
}
