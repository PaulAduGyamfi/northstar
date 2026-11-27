import type { ApplicationStatus, CandidateId } from "@northstar/domain";
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { mailClassification } from "./mail-classification-schema.js";
import { mailLinkDecision } from "./mail-link-decision-schema.js";
import { type MATCH_STEPS, mailLink, type QUEUE_REASONS } from "./mail-link-schema.js";
import { type Origin, readOrigins } from "./origin-write.js";
import { recruiterGrade } from "./recruiter-grade-schema.js";
import { readRegrades } from "./recruiter-regrade-write.js";
import { inSpan } from "./resilience-event.js";
import { application, company, job } from "./schema.js";

// The unified job inbox (NS-165, INB-006): linked mail threads grouped by application, and the
// threads waiting for Paul to link them. Read-only, from mail_link: Gmail ids, steps, flags and
// times only. Subjects, senders and bodies are never stored, so they can't appear here.

// The kind a thread shows when its newest decided message was verification mail left alone
// (NS-271): not one of the mail kinds, so the Inbox words it apart.
export const VERIFICATION_KIND = "verification";

export type InboxThread = {
  gmailThreadId: string;
  messages: number;
  lastReceivedAt: Date;
  // How the newest message was linked: a matching step, or `paul` when he linked it from the
  // confirm queue (NS-262).
  step: (typeof MATCH_STEPS)[number] | "paul";
  // Any message's sender was verified for this application (INB-011).
  senderVerified: boolean;
  // The newest classified message's kind (NS-261); null until one is classified.
  kind: string | null;
  // The newest graded message's recruiter grade (NS-238); absent when none is graded.
  recruiterGrade?: ThreadGrade;
};

// A recruiter grade as the inbox shows it: codes only, never email text. `paulGrade` is Paul's own
// newest letter for that message (NS-238 item 3), absent until he regrades it.
export type ThreadGrade = {
  grade: string;
  reasons: string[];
  confidence: string;
  paulGrade?: string;
};

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

// Paul's decision on a queued message (NS-262), joined to its mail_link row: a message he linked
// counts under that application, and one he decided either way leaves the queue.
const decisionJoin = and(
  eq(mailLinkDecision.candidateId, mailLink.candidateId),
  eq(mailLinkDecision.gmailMessageId, mailLink.gmailMessageId),
);
// The application a message belongs to: matching's link, else Paul's.
const linkedTo = sql<
  string | null
>`coalesce(${mailLink.applicationId}, ${mailLinkDecision.applicationId})`;

export async function readInboxThreads(db: Db, candidateId: CandidateId): Promise<Inbox> {
  return inSpan("db.inbox.read", {}, async (span) => {
    const lastReceived = sql<Date>`max(${mailLink.receivedAt})`;
    const linked = await db
      .select({
        applicationId: linkedTo,
        gmailThreadId: mailLink.gmailThreadId,
        messages: sql<number>`count(*)::int`,
        lastReceivedAt: lastReceived,
        step: sql<string>`(array_agg(coalesce(${mailLink.step}, 'paul') order by ${mailLink.receivedAt} desc))[1]`,
        senderVerified: sql<boolean>`bool_or(${mailLink.senderVerified})`,
        jobTitle: job.title,
        company: company.name,
        status: application.status,
      })
      .from(mailLink)
      .leftJoin(mailLinkDecision, decisionJoin)
      .innerJoin(
        application,
        and(eq(application.id, linkedTo), eq(application.candidateId, mailLink.candidateId)),
      )
      .innerJoin(job, eq(job.id, application.jobId))
      .leftJoin(company, eq(company.id, job.companyId))
      .where(eq(mailLink.candidateId, candidateId))
      .groupBy(linkedTo, mailLink.gmailThreadId, job.title, company.name, application.status)
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
      .leftJoin(mailLinkDecision, decisionJoin)
      .where(
        and(
          eq(mailLink.candidateId, candidateId),
          isNull(mailLink.applicationId),
          isNull(mailLinkDecision.id),
        ),
      )
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
        gmailMessageId: mailLink.gmailMessageId,
        applicationId: linkedTo,
        // A dismissed message leaves the queue, so its grade belongs to no thread shown.
        dismissed: sql<boolean>`${mailLinkDecision.decision} = 'dismissed'`,
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
      .leftJoin(mailLinkDecision, decisionJoin)
      .where(
        and(
          eq(recruiterGrade.candidateId, candidateId),
          // Only the threads this read returns, so it stays as bounded as they are.
          inArray(mailLink.gmailThreadId, [
            "",
            ...new Set([...linked, ...queued].map((t) => t.gmailThreadId)),
          ]),
        ),
      )
      .orderBy(desc(mailLink.receivedAt), desc(mailLink.gmailMessageId));
    // Paul's own letters (NS-238 item 3) for the graded messages this read shows.
    const regrades = await readRegrades(
      db,
      candidateId,
      gradeRows.map((g) => g.gmailMessageId),
    );
    for (const g of gradeRows) {
      if (g.dismissed === true) continue;
      const key = `${g.gmailThreadId}:${g.applicationId ?? ""}`;
      if (!grades.has(key)) {
        const paul = regrades.get(g.gmailMessageId);
        grades.set(key, {
          grade: g.grade,
          reasons: g.reasons,
          confidence: g.confidence,
          ...(paul === undefined ? {} : { paulGrade: paul }),
        });
      }
    }

    // Each linked thread's newest classified message's kind (NS-261), keyed like the grades. A
    // message that went to review has no kind, so an older classified one shows instead. A
    // verification email left alone (NS-271) shows as `verification`, which is no mail kind.
    const kinds = new Map<string, string>();
    const kindRows = await db
      .select({
        gmailThreadId: mailLink.gmailThreadId,
        applicationId: linkedTo,
        kind: sql<
          string | null
        >`case when ${mailClassification.outcome} = 'skipped' then ${VERIFICATION_KIND} else ${mailClassification.kind} end`,
      })
      .from(mailClassification)
      .innerJoin(
        mailLink,
        and(
          eq(mailLink.candidateId, mailClassification.candidateId),
          eq(mailLink.gmailMessageId, mailClassification.gmailMessageId),
        ),
      )
      .leftJoin(mailLinkDecision, decisionJoin)
      .where(
        and(
          eq(mailClassification.candidateId, candidateId),
          or(isNotNull(mailClassification.kind), eq(mailClassification.outcome, "skipped")),
          isNotNull(linkedTo),
          inArray(mailLink.gmailThreadId, ["", ...new Set(linked.map((t) => t.gmailThreadId))]),
        ),
      )
      .orderBy(desc(mailLink.receivedAt), desc(mailLink.gmailMessageId));
    for (const k of kindRows) {
      const key = `${k.gmailThreadId}:${k.applicationId ?? ""}`;
      if (!kinds.has(key) && k.kind !== null) kinds.set(key, k.kind);
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
        kind: kinds.get(`${r.gmailThreadId}:${id}`) ?? null,
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
