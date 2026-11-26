import { type CandidateId, feedLine } from "@northstar/domain";
import { and, asc, desc, eq, gt, inArray, lt } from "drizzle-orm";
import type { Db } from "./db.js";
import { inSpan } from "./resilience-event.js";
import { application, company, domainEvent, job } from "./schema.js";

// The activity feed (OBS-002): a candidate's events newest first, each as one plain sentence.
// Read-only. readFeedAfter serves the app's live feed (NS-153): what's new since the newest line
// shown.

export type FeedItem = {
  // Position in the log: pass the last one shown as `before` to read the next page.
  position: bigint;
  occurredAt: Date;
  type: string;
  actor: string;
  line: string;
  // The event's aggregate id ("job:<id>", "application:<id>", ...): what readFeedNames looks up.
  aggregate: string;
};

export const MAX_FEED_PAGE = 200;

// The columns a feed line is made from.
const columns = {
  position: domainEvent.position,
  occurredAt: domainEvent.occurredAt,
  type: domainEvent.type,
  actor: domainEvent.actor,
  aggregate: domainEvent.aggregate,
  reason: domainEvent.reason,
  payload: domainEvent.payload,
};
type Row = { [K in keyof typeof columns]: (typeof columns)[K]["_"]["data"] };

// One event as a feed item. The text comes only from feedLine (db.md).
const toItem = (r: Row): FeedItem => ({
  position: r.position,
  occurredAt: r.occurredAt,
  type: r.type,
  actor: r.actor,
  line: feedLine({ type: r.type, actor: r.actor, reason: r.reason, payload: r.payload }),
  aggregate: r.aggregate,
});

function checkLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FEED_PAGE) {
    throw new RangeError(`feed page size must be 1 to ${MAX_FEED_PAGE}`);
  }
}

export async function readFeed(
  db: Db,
  candidateId: CandidateId,
  page: { before?: bigint; limit: number },
): Promise<FeedItem[]> {
  checkLimit(page.limit);
  return inSpan("feed.read", { "northstar.feed.limit": page.limit }, async (span) => {
    const rows = await db
      .select(columns)
      .from(domainEvent)
      .where(
        and(
          eq(domainEvent.candidateId, candidateId),
          page.before === undefined ? undefined : lt(domainEvent.position, page.before),
        ),
      )
      .orderBy(desc(domainEvent.position))
      .limit(page.limit);
    span.setAttribute("northstar.feed.items", rows.length);
    return rows.map(toItem);
  });
}

// The lines after a position, oldest first: what a live feed adds on top of what it shows.
export async function readFeedAfter(
  db: Db,
  candidateId: CandidateId,
  page: { after: bigint; limit: number },
): Promise<FeedItem[]> {
  checkLimit(page.limit);
  return inSpan("feed.read_after", { "northstar.feed.limit": page.limit }, async (span) => {
    const rows = await db
      .select(columns)
      .from(domainEvent)
      .where(and(eq(domainEvent.candidateId, candidateId), gt(domainEvent.position, page.after)))
      .orderBy(asc(domainEvent.position))
      .limit(page.limit);
    span.setAttribute("northstar.feed.items", rows.length);
    return rows.map(toItem);
  });
}

// The job a feed line is about, shown next to the line (NS-189). Null while a draft job lacks it.
export type FeedNames = { jobTitle: string | null; company: string | null };

// The aggregate ids that name a job. Anything else, or a malformed id, is never queried (a bad
// uuid would make Postgres throw).
const NAMED = /^(job|application):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

// The job title and company behind each `job:<id>` and `application:<id>` aggregate, from the
// candidate's own rows only. Read at display time, never stored in events or written into a line
// (db.md). Aggregates without a name (other kinds, unknown ids, another candidate's rows) are
// absent from the map.
export async function readFeedNames(
  db: Db,
  candidateId: CandidateId,
  aggregates: readonly string[],
): Promise<Map<string, FeedNames>> {
  const jobIds = new Set<string>();
  const applicationIds = new Set<string>();
  for (const a of aggregates) {
    const m = NAMED.exec(a);
    if (!m?.[2]) continue;
    (m[1] === "job" ? jobIds : applicationIds).add(m[2]);
  }
  return inSpan("feed.names", {}, async (span) => {
    const names = new Map<string, FeedNames>();
    if (jobIds.size > 0) {
      const rows = await db
        .select({ id: job.id, jobTitle: job.title, company: company.name })
        .from(job)
        .leftJoin(company, eq(company.id, job.companyId))
        .where(and(eq(job.candidateId, candidateId), inArray(job.id, [...jobIds])));
      for (const r of rows) names.set(`job:${r.id}`, { jobTitle: r.jobTitle, company: r.company });
    }
    if (applicationIds.size > 0) {
      const rows = await db
        .select({ id: application.id, jobTitle: job.title, company: company.name })
        .from(application)
        .innerJoin(job, eq(job.id, application.jobId))
        .leftJoin(company, eq(company.id, job.companyId))
        .where(
          and(
            eq(application.candidateId, candidateId),
            inArray(application.id, [...applicationIds]),
          ),
        );
      for (const r of rows) {
        names.set(`application:${r.id}`, { jobTitle: r.jobTitle, company: r.company });
      }
    }
    // How many lines got a name: a count only, never a name (spans carry no job text).
    span.setAttribute("northstar.feed.names", names.size);
    return names;
  });
}
