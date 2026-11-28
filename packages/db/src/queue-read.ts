import type { CandidateId } from "@northstar/domain";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { fitScore } from "./fit-schema.js";
import { readClosedJobIds } from "./liveness-write.js";
import { application, domainEvent, job } from "./schema.js";

// What the queueing rule reads (NS-280 slice 1, MAT-003, APPLY-001): which ready jobs may become
// a `queued` application, and how many the rule already queued today. Read-only, ids and counts
// only, never a title, company or URL.

// At most this many candidates a pass: a burst of new jobs waits for the next pass.
export const MAX_QUEUE_READ = 50;

// The candidate's ready jobs whose newest Fit Score (by scored_at, the alert pass's rule) is in
// the `queue` band, with no application yet and a posting not known closed, freshest first.
export async function readQueueCandidates(db: Db, candidateId: CandidateId): Promise<string[]> {
  const scores = await db
    .select({
      jobId: fitScore.jobId,
      band: fitScore.band,
      // The age rule the queue and alerts use: the posting date, else when it was first seen.
      seen: sql<Date>`coalesce(${job.postedAt}, ${job.firstSeenAt})`,
    })
    .from(fitScore)
    .innerJoin(job, and(eq(job.id, fitScore.jobId), eq(job.candidateId, fitScore.candidateId)))
    .where(
      and(
        eq(fitScore.candidateId, candidateId),
        eq(job.status, "ready"),
        // One application per job (application_one_per_job): a job already applied to is done.
        sql`not exists (select 1 from ${application} where ${application.candidateId} = ${fitScore.candidateId} and ${application.jobId} = ${fitScore.jobId})`,
      ),
    )
    .orderBy(desc(fitScore.scoredAt), desc(fitScore.id));
  // The first row per job is its newest score; a newer score out of the band takes the job out.
  const newest = new Map<string, { band: string; seen: Date }>();
  for (const s of scores) if (!newest.has(s.jobId)) newest.set(s.jobId, s);
  const closed = await readClosedJobIds(db, candidateId);
  return [...newest.entries()]
    .filter(([id, s]) => s.band === "queue" && !closed.has(id))
    .sort(([, a], [, b]) => new Date(b.seen).getTime() - new Date(a.seen).getTime())
    .slice(0, MAX_QUEUE_READ)
    .map(([id]) => id);
}

// How many applications the queueing rule created today (UTC day, by the Gate's clock): the
// candidate's `application.created` events started by Northstar at `queued`. The day starts at
// midnight UTC of northstar_gate_now(), computed in the same statement; the events are stamped by
// the database's now(), the same clock outside tests.
export async function countQueuedToday(db: Db, candidateId: CandidateId): Promise<number> {
  const dayStart = sql`date_trunc('day', northstar_gate_now() at time zone 'UTC') at time zone 'UTC'`;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(domainEvent)
    .where(
      and(
        eq(domainEvent.candidateId, candidateId),
        eq(domainEvent.type, "application.created"),
        gte(domainEvent.occurredAt, dayStart),
        sql`${domainEvent.payload} ->> 'startedBy' = 'northstar'`,
        sql`${domainEvent.payload} ->> 'to' = 'queued'`,
      ),
    );
  return row?.n ?? 0;
}
