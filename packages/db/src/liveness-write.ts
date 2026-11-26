import type { CandidateId } from "@northstar/domain";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "./db.js";
import { type POSTING_OUTCOMES, postingCheck } from "./liveness-schema.js";
import { appendEvent, inSpan } from "./resilience-event.js";
import { job, jobSource } from "./schema.js";

// Posting liveness (NS-173 slice 2, SRC-010): which ready jobs are due a re-check, the only writer
// of posting_check, and which jobs are closed. Events carry ids and the ATS, never a URL or title.

export type PostingOutcome = (typeof POSTING_OUTCOMES)[number];
// The ATSes whose single postings can be re-checked through a public API.
export const CHECKABLE_ATS = ["greenhouse", "lever", "ashby", "smartrecruiters"] as const;
export type CheckableAts = (typeof CHECKABLE_ATS)[number];

export type JobToCheck = { jobId: string; ats: CheckableAts; url: string };

// Every job's newest check, oldest first so later rows replace earlier ones.
async function latestChecks(
  db: Pick<Db, "select">,
  candidateId: CandidateId,
): Promise<Map<string, { outcome: PostingOutcome; checkedAt: Date }>> {
  const rows = await db
    .select({
      jobId: postingCheck.jobId,
      outcome: postingCheck.outcome,
      at: postingCheck.checkedAt,
    })
    .from(postingCheck)
    .where(eq(postingCheck.candidateId, candidateId))
    .orderBy(asc(postingCheck.position));
  const latest = new Map<string, { outcome: PostingOutcome; checkedAt: Date }>();
  for (const r of rows)
    latest.set(r.jobId, { outcome: r.outcome as PostingOutcome, checkedAt: r.at });
  return latest;
}

// Ready jobs with a checkable ATS source that aren't closed and weren't checked since
// `checkedBefore`, never-checked first, then oldest check; at most `limit`.
export async function readJobsToCheck(
  db: Db,
  candidateId: CandidateId,
  input: { checkedBefore: Date; limit: number },
): Promise<JobToCheck[]> {
  const sources = await db
    .select({ jobId: jobSource.jobId, ats: jobSource.ats, url: jobSource.url })
    .from(jobSource)
    .innerJoin(job, eq(job.id, jobSource.jobId))
    .where(
      and(
        eq(jobSource.candidateId, candidateId),
        eq(job.status, "ready"),
        inArray(jobSource.ats, [...CHECKABLE_ATS]),
        isNotNull(jobSource.atsPostingId),
      ),
    )
    .orderBy(asc(jobSource.fetchedAt), asc(jobSource.id));
  const latest = await latestChecks(db, candidateId);
  const seen = new Set<string>();
  const due: (JobToCheck & { lastAt: number })[] = [];
  for (const s of sources) {
    // One source per job: the first one saved.
    if (seen.has(s.jobId)) continue;
    seen.add(s.jobId);
    const last = latest.get(s.jobId);
    if (last?.outcome === "closed") continue;
    if (last && last.checkedAt >= input.checkedBefore) continue;
    due.push({
      jobId: s.jobId,
      ats: s.ats as CheckableAts,
      url: s.url,
      lastAt: last?.checkedAt.getTime() ?? 0,
    });
  }
  return due
    .sort((a, b) => a.lastAt - b.lastAt)
    .slice(0, input.limit)
    .map(({ jobId, ats, url }) => ({ jobId, ats, url }));
}

// Stores one answered check. A job that turns closed gets one `job.closed` event.
export async function recordPostingCheck(
  db: Db,
  input: { candidateId: CandidateId; jobId: string; ats: CheckableAts; outcome: PostingOutcome },
): Promise<{ closedNow: boolean }> {
  return inSpan(
    "job.posting_check",
    { "northstar.job.id": input.jobId, "northstar.posting.outcome": input.outcome },
    (span) =>
      db.transaction(async (tx) => {
        const [previous] = await tx
          .select({ outcome: postingCheck.outcome })
          .from(postingCheck)
          .where(
            and(
              eq(postingCheck.candidateId, input.candidateId),
              eq(postingCheck.jobId, input.jobId),
            ),
          )
          .orderBy(asc(postingCheck.position))
          .then((rows) => rows.slice(-1));
        const [row] = await tx
          .insert(postingCheck)
          .values({ candidateId: input.candidateId, jobId: input.jobId, outcome: input.outcome })
          .returning({ id: postingCheck.id, checkedAt: postingCheck.checkedAt });
        if (!row) throw new Error("posting_check insert returned no row");
        const closedNow = input.outcome === "closed" && previous?.outcome !== "closed";
        if (closedNow)
          await appendEvent(tx, span, {
            candidateId: input.candidateId,
            aggregate: `job:${input.jobId}`,
            type: "job.closed",
            actor: "system",
            // Fixed words only: no title, company or URL.
            reason: "A saved job's posting has closed; it leaves the queue",
            payload: { jobId: input.jobId, ats: input.ats },
            idempotencyKey: `job.closed:${row.id}`,
            at: row.checkedAt,
          });
        return { closedNow };
      }),
  );
}

// The jobs whose newest check found the posting closed.
export async function readClosedJobIds(
  db: Pick<Db, "select">,
  candidateId: CandidateId,
): Promise<Set<string>> {
  const latest = await latestChecks(db, candidateId);
  return new Set([...latest].filter(([, c]) => c.outcome === "closed").map(([id]) => id));
}
