import {
  APPLICATION_STATUSES,
  type ApplicationHistory,
  type ApplicationStatus,
  type CandidateId,
  feedLine,
} from "@northstar/domain";
import { and, asc, desc, eq, gte, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { fitScore } from "./fit-schema.js";
import type { FitBand } from "./fit-write.js";
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
  // The job's latest fit score and band (NS-207), or null while it is unscored.
  fitScore: number | null;
  fitBand: FitBand | null;
  createdAt: Date;
  updatedAt: Date;
};

// What the pipeline can be narrowed by (NS-207, DSH-001), applied in SQL. All optional; the API
// checks their shapes first.
export type ApplicationFilter = {
  // Part of the company name, case-insensitive.
  company?: string;
  band?: FitBand;
  // The job's ATS, or "other" for a job with none.
  source?: string;
  // The application's creation day, inclusive, YYYY-MM-DD in UTC.
  from?: string;
  to?: string;
};

export type TimelineItem = { occurredAt: Date; type: string; actor: string; line: string };

// The board shows at most this many: far above a year of applying.
export const MAX_APPLICATIONS = 500;
// One application's timeline holds at most this many events.
const MAX_TIMELINE = 500;

// The job's newest score row, by when it was scored (any preference or resume version: the
// newest is what Paul last saw). Built from column references, so Drizzle names the tables.
const latestFit = (column: "score" | "band") =>
  sql`(select ${fitScore[column]} from ${fitScore} where ${fitScore.jobId} = ${job.id} and ${fitScore.candidateId} = ${application.candidateId} order by ${fitScore.scoredAt} desc, ${fitScore.id} limit 1)`;

const columns = {
  applicationId: application.id,
  status: application.status,
  jobTitle: job.title,
  company: company.name,
  ats: job.ats,
  fitScore: sql<number | null>`${latestFit("score")}`,
  fitBand: sql<string | null>`${latestFit("band")}`,
  createdAt: application.createdAt,
  updatedAt: application.updatedAt,
};

const toRow = (
  r: Omit<ApplicationRow, "status" | "fitBand"> & { status: string; fitBand: string | null },
): ApplicationRow => ({
  ...r,
  status: r.status as ApplicationStatus,
  fitBand: r.fitBand as FitBand | null,
});

const DAY_MS = 24 * 60 * 60 * 1000;

// The filter's conditions; each is a bound parameter, never text spliced into SQL.
function filterConditions(f: ApplicationFilter): SQL[] {
  const out: SQL[] = [];
  if (f.company !== undefined) {
    out.push(sql`strpos(lower(${company.name}), lower(${f.company})) > 0`);
  }
  if (f.band !== undefined) out.push(sql`${latestFit("band")} = ${f.band}`);
  if (f.source === "other") out.push(isNull(job.ats));
  else if (f.source !== undefined) out.push(eq(job.ats, f.source));
  if (f.from !== undefined) out.push(gte(application.createdAt, new Date(`${f.from}T00:00:00Z`)));
  if (f.to !== undefined) {
    out.push(lt(application.createdAt, new Date(Date.parse(`${f.to}T00:00:00Z`) + DAY_MS)));
  }
  return out;
}

export async function listApplications(
  db: Db,
  candidateId: CandidateId,
  filter: ApplicationFilter = {},
): Promise<ApplicationRow[]> {
  const conditions = filterConditions(filter);
  return inSpan(
    "db.pipeline.list",
    { "northstar.pipeline.filters": conditions.length },
    async (span) => {
      const rows = await db
        .select(columns)
        .from(application)
        .innerJoin(job, eq(job.id, application.jobId))
        .leftJoin(company, eq(company.id, job.companyId))
        .where(and(eq(application.candidateId, candidateId), ...conditions))
        .orderBy(desc(application.updatedAt), asc(application.id))
        .limit(MAX_APPLICATIONS);
      span.setAttribute("northstar.pipeline.applications", rows.length);
      return rows.map(toRow);
    },
  );
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
      // The newest MAX_TIMELINE, so a long history drops its oldest events, never its latest.
      .orderBy(desc(domainEvent.position))
      .limit(MAX_TIMELINE);
    span.setAttribute("northstar.pipeline.events", events.length);
    return {
      application: toRow(row),
      // Shown oldest first.
      items: events.reverse().map((e) => ({
        occurredAt: e.occurredAt,
        type: e.type,
        actor: e.actor,
        line: feedLine({ type: e.type, actor: e.actor, reason: e.reason, payload: e.payload }),
      })),
    };
  });
}

// The metrics read at most this many applications: years of applying.
const MAX_HISTORIES = 5000;
const STATUS_SET: ReadonlySet<string> = new Set(APPLICATION_STATUSES);

// Each application's history for the pipeline metrics (NS-208, DSH-002/004): when it was created,
// its job's ATS, newest fit band and posting time (null when unknown), and its status moves from the
// `application.*` events, oldest first. Ids, times, statuses and bands only: never a title,
// company or text.
export async function readApplicationHistories(
  db: Db,
  candidateId: CandidateId,
): Promise<ApplicationHistory[]> {
  return inSpan("db.pipeline.histories", {}, async (span) => {
    const apps = await db
      .select({
        id: application.id,
        createdAt: application.createdAt,
        source: job.ats,
        fitBand: sql<string | null>`${latestFit("band")}`,
        // The posting time only: when Northstar first saw a job is near when Paul applied, and
        // would make every undated job look applied-within-a-day. Unknown stays unknown.
        postedAt: job.postedAt,
      })
      .from(application)
      .innerJoin(job, eq(job.id, application.jobId))
      .where(eq(application.candidateId, candidateId))
      .orderBy(asc(application.createdAt), asc(application.id))
      .limit(MAX_HISTORIES);
    const moves = await db
      .select({
        aggregate: domainEvent.aggregate,
        to: sql<string | null>`${domainEvent.payload}->>'to'`,
        at: domainEvent.occurredAt,
      })
      .from(domainEvent)
      .where(
        and(
          eq(domainEvent.candidateId, candidateId),
          sql`${domainEvent.aggregate} like 'application:%'`,
          sql`${domainEvent.type} like 'application.%'`,
        ),
      )
      .orderBy(asc(domainEvent.position));
    const byApp = new Map<string, { to: ApplicationStatus; at: Date }[]>();
    for (const m of moves) {
      // Status moves and `application.created` (its entry status, or `submitted` for one Paul
      // sent by hand) carry a `to`; any other application event is skipped.
      if (m.to === null || !STATUS_SET.has(m.to)) continue;
      const id = m.aggregate.slice("application:".length);
      const list = byApp.get(id) ?? [];
      list.push({ to: m.to as ApplicationStatus, at: m.at });
      byApp.set(id, list);
    }
    span.setAttribute("northstar.pipeline.applications", apps.length);
    return apps.map((a) => ({
      createdAt: a.createdAt,
      source: a.source,
      fitBand: a.fitBand as ApplicationHistory["fitBand"],
      postedAt: a.postedAt,
      moves: byApp.get(a.id) ?? [],
    }));
  });
}
