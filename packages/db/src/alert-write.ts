import { randomUUID } from "node:crypto";
import type { CandidateId } from "@northstar/domain";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "./db.js";
import { fitScore } from "./fit-schema.js";
import { domainEvent, job, jobSource } from "./schema.js";

// Fresh-job alerts (NS-163, SRC-015). packages/sources decides who gets an alert and when; this
// module reads what it decides from and stores each decision as one domain event whose key is
// per job, so a job is alerted at most once and held at most once. No table of its own.

export const FRESH_ALERT = "job.fresh_alert";
export const FRESH_ALERT_HELD = "job.fresh_alert_held";

export type AlertCandidate = {
  jobId: string;
  postedAt: Date | null;
  firstSeenAt: Date;
  // The latest score, which is in the queue band (MAT-003's "high fit").
  score: number;
  // Where the job was found, for matching it to a watched board's tier.
  sourceUrls: string[];
  alerted: boolean;
  held: boolean;
};

// Ready jobs whose latest fit score is in the queue band, with their alert state.
export async function readAlertCandidates(
  db: Db,
  candidateId: CandidateId,
): Promise<AlertCandidate[]> {
  const scores = await db
    .select({
      jobId: fitScore.jobId,
      score: fitScore.score,
      band: fitScore.band,
      postedAt: job.postedAt,
      firstSeenAt: job.firstSeenAt,
    })
    .from(fitScore)
    .innerJoin(job, eq(job.id, fitScore.jobId))
    .where(and(eq(fitScore.candidateId, candidateId), eq(job.status, "ready")))
    .orderBy(desc(fitScore.scoredAt));
  // The first row per job is its latest score (newest first above).
  const latest = new Map<string, (typeof scores)[number]>();
  for (const s of scores) if (!latest.has(s.jobId)) latest.set(s.jobId, s);
  const queued = [...latest.values()].filter((s) => s.band === "queue");
  if (queued.length === 0) return [];
  const ids = queued.map((s) => s.jobId);
  const [sources, events] = await Promise.all([
    db
      .select({ jobId: jobSource.jobId, url: jobSource.url })
      .from(jobSource)
      .where(and(eq(jobSource.candidateId, candidateId), inArray(jobSource.jobId, ids))),
    db
      .select({ aggregate: domainEvent.aggregate, type: domainEvent.type })
      .from(domainEvent)
      .where(
        and(
          eq(domainEvent.candidateId, candidateId),
          inArray(domainEvent.type, [FRESH_ALERT, FRESH_ALERT_HELD]),
          inArray(
            domainEvent.aggregate,
            ids.map((id) => `job:${id}`),
          ),
        ),
      ),
  ]);
  const has = (jobId: string, type: string) =>
    events.some((e) => e.aggregate === `job:${jobId}` && e.type === type);
  return queued.map((s) => ({
    jobId: s.jobId,
    postedAt: s.postedAt,
    firstSeenAt: s.firstSeenAt,
    score: s.score,
    sourceUrls: sources.filter((x) => x.jobId === s.jobId).map((x) => x.url),
    alerted: has(s.jobId, FRESH_ALERT),
    held: has(s.jobId, FRESH_ALERT_HELD),
  }));
}

export type AlertInput = {
  candidateId: CandidateId;
  jobId: string;
  score: number;
  // Minutes since the job was posted (or first seen), at this decision.
  ageMinutes: number;
  tier: 1 | 2 | 3 | null;
  now: Date;
};

// "12 min ago" under an hour, then whole hours, then whole days.
export function ageText(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h ago`;
  return `${Math.floor(m / (24 * 60))} days ago`;
}

// The alert itself. Its reason is the sentence Paul sees in the feed (numbers only, never a
// title, company or URL). `wasHeld` marks one released after quiet hours.
export function recordFreshAlert(
  db: Db,
  input: AlertInput & { wasHeld: boolean },
): Promise<"recorded" | "exists"> {
  const held = input.wasHeld ? " · held for quiet hours" : "";
  return insertAlertEvent(db, input, FRESH_ALERT, {
    reason: `Posted ${ageText(input.ageMinutes)} · Fit ${input.score}${held} · ready to approve`,
    payload: { wasHeld: input.wasHeld },
  });
}

// An alert held for quiet hours; it is sent on the first pass after they end.
export function recordAlertHeld(db: Db, input: AlertInput): Promise<"recorded" | "exists"> {
  return insertAlertEvent(db, input, FRESH_ALERT_HELD, {
    reason: `Fit ${input.score} job posted ${ageText(input.ageMinutes)}: alert held for quiet hours`,
    payload: {},
  });
}

async function insertAlertEvent(
  db: Db,
  input: AlertInput,
  type: typeof FRESH_ALERT | typeof FRESH_ALERT_HELD,
  extra: { reason: string; payload: Record<string, unknown> },
): Promise<"recorded" | "exists"> {
  const [row] = await db
    .insert(domainEvent)
    .values({
      id: randomUUID(),
      candidateId: input.candidateId,
      aggregate: `job:${input.jobId}`,
      type,
      actor: "system",
      reason: extra.reason,
      inputsSummary: "",
      // Ids and numbers only: never a title, company or URL.
      payload: {
        jobId: input.jobId,
        score: input.score,
        ageMinutes: Math.max(0, Math.floor(input.ageMinutes)),
        tier: input.tier,
        ...extra.payload,
      },
      links: [],
      traceId: null,
      // One per job: a repeat pass stores nothing (SRC-015 "exactly one alert").
      idempotencyKey: `${type}:${input.jobId}`,
      occurredAt: input.now,
    })
    .onConflictDoNothing({ target: [domainEvent.candidateId, domainEvent.idempotencyKey] })
    .returning({ id: domainEvent.id });
  return row ? "recorded" : "exists";
}
