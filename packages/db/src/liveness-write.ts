import { ApplicationId, type ApplicationStatus, type CandidateId } from "@northstar/domain";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "./db.js";
import { type POSTING_OUTCOMES, postingCheck } from "./liveness-schema.js";
import { appendEvent, inSpan } from "./resilience-event.js";
import { application, job, jobSource } from "./schema.js";
import { transitionApplication } from "./transition-application.js";

// Posting liveness (NS-173 slice 2, SRC-010): which ready jobs are due a re-check, the only writer
// of posting_check, and which jobs are closed. Events carry ids and the ATS, never a URL or title.

export type PostingOutcome = (typeof POSTING_OUTCOMES)[number];
// The ATSes whose single postings can be re-checked through a public API.
export const CHECKABLE_ATS = ["greenhouse", "lever", "ashby", "smartrecruiters"] as const;
export type CheckableAts = (typeof CHECKABLE_ATS)[number];

export type JobToCheck = { jobId: string; ats: CheckableAts; url: string };

type JobChecks = {
  // The two newest answers (open or closed), newest last, with the id of the newest one.
  answers: ("open" | "closed")[];
  lastAnswerId: string | null;
  // The newest attempt of any kind, unavailable included: it sets the job's place in line.
  lastAttemptAt: Date;
};

// One mistaken 404 (a renamed board, a region the API doesn't serve) mustn't close a job, so a job
// is closed only when its two newest answers are both closed. Unavailable attempts are skipped.
const isClosed = (answers: readonly string[]) =>
  answers.length === 2 && answers.every((a) => a === "closed");

async function readChecks(
  db: Pick<Db, "select">,
  candidateId: CandidateId,
  jobId?: string,
): Promise<Map<string, JobChecks>> {
  const rows = await db
    .select({
      id: postingCheck.id,
      jobId: postingCheck.jobId,
      outcome: postingCheck.outcome,
      at: postingCheck.checkedAt,
    })
    .from(postingCheck)
    .where(
      and(
        eq(postingCheck.candidateId, candidateId),
        jobId === undefined ? undefined : eq(postingCheck.jobId, jobId),
      ),
    )
    .orderBy(asc(postingCheck.position));
  const checks = new Map<string, JobChecks>();
  for (const r of rows) {
    const c = checks.get(r.jobId) ?? { answers: [], lastAnswerId: null, lastAttemptAt: r.at };
    c.lastAttemptAt = r.at;
    if (r.outcome === "open" || r.outcome === "closed") {
      c.answers = [...c.answers, r.outcome as "open" | "closed"].slice(-2);
      c.lastAnswerId = r.id;
    }
    checks.set(r.jobId, c);
  }
  return checks;
}

// Ready jobs with a source the ATS's API served (an unlisted Ashby posting or an EU Lever one read
// from its page isn't on the API, so "absent" would mean nothing), whose newest attempt is older
// than `checkedBefore`, or older than `closedCheckedBefore` for a closed job (a wrong closure can
// still come back). Never-tried first, then the oldest attempt; at most `limit`.
export async function readJobsToCheck(
  db: Db,
  candidateId: CandidateId,
  input: { checkedBefore: Date; closedCheckedBefore: Date; limit: number },
): Promise<JobToCheck[]> {
  const sources = await db
    .select({ jobId: jobSource.jobId, ats: jobSource.ats, url: jobSource.url })
    .from(jobSource)
    .innerJoin(job, eq(job.id, jobSource.jobId))
    .where(
      and(
        eq(jobSource.candidateId, candidateId),
        eq(job.status, "ready"),
        eq(jobSource.method, "ats_api"),
        inArray(jobSource.ats, [...CHECKABLE_ATS]),
        isNotNull(jobSource.atsPostingId),
      ),
    )
    .orderBy(asc(jobSource.fetchedAt), asc(jobSource.id));
  const checks = await readChecks(db, candidateId);
  const seen = new Set<string>();
  const due: (JobToCheck & { lastAt: number })[] = [];
  for (const s of sources) {
    // One source per job: the first one saved.
    if (seen.has(s.jobId)) continue;
    seen.add(s.jobId);
    const c = checks.get(s.jobId);
    const cutoff = c && isClosed(c.answers) ? input.closedCheckedBefore : input.checkedBefore;
    if (c && c.lastAttemptAt >= cutoff) continue;
    due.push({
      jobId: s.jobId,
      ats: s.ats as CheckableAts,
      url: s.url,
      lastAt: c?.lastAttemptAt.getTime() ?? 0,
    });
  }
  return due
    .sort((a, b) => a.lastAt - b.lastAt)
    .slice(0, input.limit)
    .map(({ jobId, ats, url }) => ({ jobId, ats, url }));
}

// Stores one attempt. A job that turns closed (its second closed answer in a row) gets one
// `job.closed` event; a closed job that answers open again gets one `job.reopened`.
export async function recordPostingCheck(
  db: Db,
  input: { candidateId: CandidateId; jobId: string; ats: CheckableAts; outcome: PostingOutcome },
): Promise<{ closedNow: boolean; reopenedNow: boolean }> {
  return inSpan(
    "job.posting_check",
    { "northstar.job.id": input.jobId, "northstar.posting.outcome": input.outcome },
    (span) =>
      db.transaction(async (tx) => {
        const before = (await readChecks(tx, input.candidateId, input.jobId)).get(input.jobId);
        const answers = before?.answers ?? [];
        const [row] = await tx
          .insert(postingCheck)
          .values({ candidateId: input.candidateId, jobId: input.jobId, outcome: input.outcome })
          .returning({ id: postingCheck.id, checkedAt: postingCheck.checkedAt });
        if (!row) throw new Error("posting_check insert returned no row");
        const wasClosed = isClosed(answers);
        const closedNow = input.outcome === "closed" && answers.at(-1) === "closed" && !wasClosed;
        const reopenedNow = input.outcome === "open" && wasClosed;
        if (closedNow || reopenedNow) {
          const type = closedNow ? "job.closed" : "job.reopened";
          await appendEvent(tx, span, {
            candidateId: input.candidateId,
            aggregate: `job:${input.jobId}`,
            type,
            actor: "system",
            // Fixed words only: no title, company or URL.
            reason: closedNow
              ? "A saved job's posting has closed; it leaves scoring"
              : "A saved job's posting is open again; it's scored again",
            payload: { jobId: input.jobId, ats: input.ats },
            // Keyed by the answer before this one: two passes racing write the event once.
            idempotencyKey: `${type}:${input.jobId}:${before?.lastAnswerId ?? "none"}`,
            at: row.checkedAt,
          });
        }
        return { closedNow, reopenedNow };
      }),
  );
}

// The jobs whose two newest answers both found the posting closed.
export async function readClosedJobIds(
  db: Pick<Db, "select">,
  candidateId: CandidateId,
): Promise<Set<string>> {
  const checks = await readChecks(db, candidateId);
  return new Set([...checks].filter(([, c]) => isClosed(c.answers)).map(([id]) => id));
}

// The statuses an application can leave the pipeline from when its posting closes (NS-218): it
// hasn't gone out. From submitting on, a run may be in the browser or it already went out, so
// it is left alone.
const BEFORE_SUBMISSION: readonly ApplicationStatus[] = [
  "discovered",
  "scored",
  "queued",
  "package_ready",
  "awaiting_approval",
];

// Moves every application whose job is closed and that hasn't gone out to `withdrawn`, through
// transitionApplication, with the reason code `posting_closed` (SRC-010). Safe to repeat: one key
// per application, and a withdrawn one is no longer listed. One failing application (a status
// that changed meanwhile, Postgres) is counted and never stops the others.
export async function withdrawClosedApplications(
  db: Db,
  candidateId: CandidateId,
  now?: Date,
): Promise<{ withdrawn: number; failed: number }> {
  const closed = await readClosedJobIds(db, candidateId);
  if (closed.size === 0) return { withdrawn: 0, failed: 0 };
  const open = await db
    .select({ id: application.id, status: application.status })
    .from(application)
    .where(
      and(
        eq(application.candidateId, candidateId),
        inArray(application.jobId, [...closed]),
        inArray(application.status, [...BEFORE_SUBMISSION]),
      ),
    )
    .orderBy(asc(application.createdAt), asc(application.id));
  let withdrawn = 0;
  let failed = 0;
  for (const a of open) {
    try {
      const moved = await transitionApplication(db, {
        candidateId,
        applicationId: ApplicationId.parse(a.id),
        from: a.status as ApplicationStatus,
        to: "withdrawn",
        actor: "system",
        // Fixed words only: no title, company or URL.
        reason: "The job's posting closed before the application went out",
        inputsSummary: "",
        links: [],
        reasonCode: "posting_closed",
        // Withdrawn is final, so one key per application is enough.
        idempotencyKey: `application:${a.id}:posting_closed`,
        ...(now === undefined ? {} : { now }),
      });
      if (moved.ok) withdrawn++;
      else failed++;
    } catch {
      failed++;
    }
  }
  return { withdrawn, failed };
}

// Whether the application's job is closed (its two newest answers both closed). The Apply
// Gateway asks this right before it claims (NS-218). An unknown application is not closed: the
// claim refuses it on its own.
export async function isPostingClosed(
  db: Pick<Db, "select">,
  candidateId: CandidateId,
  applicationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ jobId: application.jobId })
    .from(application)
    .where(and(eq(application.candidateId, candidateId), eq(application.id, applicationId)));
  if (!row) return false;
  const c = (await readChecks(db, candidateId, row.jobId)).get(row.jobId);
  return c !== undefined && isClosed(c.answers);
}
