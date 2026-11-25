import { type ApplicationStatus, type CandidateId, feedLine } from "@northstar/domain";
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { inSpan } from "./resilience-event.js";
import { application, company, domainEvent, job } from "./schema.js";

// The pipeline board and application timeline (NS-168, DSH-001, DSH-006). Read-only. Timeline
// text comes only from feedLine (db.md), never raw payloads.

export type ApplicationRow = {
  applicationId: string;
  status: ApplicationStatus;
  // Null while the job is a draft without them (NS-114).
  jobTitle: string | null;
  company: string | null;
  ats: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TimelineItem = { occurredAt: Date; type: string; actor: string; line: string };

// The board shows at most this many: far above a year of applying.
export const MAX_APPLICATIONS = 500;
// One application's timeline holds at most this many events.
const MAX_TIMELINE = 500;

const columns = {
  applicationId: application.id,
  status: application.status,
  jobTitle: job.title,
  company: company.name,
  ats: job.ats,
  createdAt: application.createdAt,
  updatedAt: application.updatedAt,
};

const toRow = (r: Omit<ApplicationRow, "status"> & { status: string }): ApplicationRow => ({
  ...r,
  status: r.status as ApplicationStatus,
});

export async function listApplications(
  db: Db,
  candidateId: CandidateId,
): Promise<ApplicationRow[]> {
  return inSpan("db.pipeline.list", {}, async (span) => {
    const rows = await db
      .select(columns)
      .from(application)
      .innerJoin(job, eq(job.id, application.jobId))
      .leftJoin(company, eq(company.id, job.companyId))
      .where(eq(application.candidateId, candidateId))
      .orderBy(desc(application.updatedAt), asc(application.id))
      .limit(MAX_APPLICATIONS);
    span.setAttribute("northstar.pipeline.applications", rows.length);
    return rows.map(toRow);
  });
}

// One application and its events, oldest first, or null when it isn't this candidate's.
export async function readApplicationTimeline(
  db: Db,
  candidateId: CandidateId,
  applicationId: string,
): Promise<{ application: ApplicationRow; items: TimelineItem[] } | null> {
  return inSpan("db.pipeline.timeline", {}, async (span) => {
    const [row] = await db
      .select(columns)
      .from(application)
      .innerJoin(job, eq(job.id, application.jobId))
      .leftJoin(company, eq(company.id, job.companyId))
      .where(and(eq(application.id, applicationId), eq(application.candidateId, candidateId)));
    if (!row) return null;
    const events = await db
      .select({
        occurredAt: domainEvent.occurredAt,
        type: domainEvent.type,
        actor: domainEvent.actor,
        reason: domainEvent.reason,
        payload: domainEvent.payload,
      })
      .from(domainEvent)
      .where(
        and(
          eq(domainEvent.candidateId, candidateId),
          or(
            // Its own status moves (transitionApplication).
            eq(domainEvent.aggregate, `application:${applicationId}`),
            // Events about it from other aggregates: submissions, handoffs, mail links.
            sql`${domainEvent.payload}->>'applicationId' = ${applicationId}`,
          ),
        ),
      )
      .orderBy(asc(domainEvent.position))
      .limit(MAX_TIMELINE);
    span.setAttribute("northstar.pipeline.events", events.length);
    return {
      application: toRow(row),
      items: events.map((e) => ({
        occurredAt: e.occurredAt,
        type: e.type,
        actor: e.actor,
        line: feedLine({ type: e.type, actor: e.actor, reason: e.reason, payload: e.payload }),
      })),
    };
  });
}
