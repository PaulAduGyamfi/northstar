import {
  type ApplicationId,
  type ApplicationStatus,
  type CandidateId,
  err,
  isStartedBy,
  isSubmittedVia,
  type OriginBucket,
  ok,
  originBucket,
  type Result,
  type StartedBy,
  type SubmittedVia,
} from "@northstar/domain";
import { and, eq, inArray, like } from "drizzle-orm";
import type { Db } from "./db.js";
import { appendEvent, inSpan } from "./resilience-event.js";
import { application, domainEvent, job } from "./schema.js";

// Application origin (NS-188, INB-007) and the credit report (INB-010). Origin is stored in
// events, never in a column: `startedBy` in `application.created` (written here, with the row),
// `submittedVia` in the move to `submitted` (transitionApplication). Email matching writes neither.

export type JobNotFound = { kind: "JobNotFound" };

// Creates an application with its first event and who started it, in one transaction. Repeating
// the same idempotency key hands back the first application and writes nothing.
export async function createApplication(
  db: Db,
  input: {
    candidateId: CandidateId;
    jobId: string;
    status: ApplicationStatus;
    startedBy: StartedBy;
    idempotencyKey: string;
  },
): Promise<Result<{ applicationId: string; replayed: boolean }, JobNotFound>> {
  return inSpan(
    "db.application.create",
    { "northstar.origin.started_by": input.startedBy },
    (span) =>
      db.transaction(
        async (tx): Promise<Result<{ applicationId: string; replayed: boolean }, JobNotFound>> => {
          const [before] = await tx
            .select({ aggregate: domainEvent.aggregate })
            .from(domainEvent)
            .where(
              and(
                eq(domainEvent.candidateId, input.candidateId),
                eq(domainEvent.idempotencyKey, input.idempotencyKey),
              ),
            );
          if (before) {
            return ok({
              applicationId: before.aggregate.replace(/^application:/, ""),
              replayed: true,
            });
          }
          const [owned] = await tx
            .select({ id: job.id })
            .from(job)
            .where(and(eq(job.id, input.jobId), eq(job.candidateId, input.candidateId)));
          if (!owned) return err({ kind: "JobNotFound" });
          const [row] = await tx
            .insert(application)
            .values({ candidateId: input.candidateId, jobId: input.jobId, status: input.status })
            .returning({ id: application.id, createdAt: application.createdAt });
          if (!row) throw new Error("application insert returned no row");
          await appendEvent(tx, span, {
            candidateId: input.candidateId,
            aggregate: `application:${row.id}`,
            type: "application.created",
            actor: "system",
            reason: "",
            payload: { to: input.status, startedBy: input.startedBy },
            idempotencyKey: input.idempotencyKey,
            at: row.createdAt,
          });
          return ok({ applicationId: row.id, replayed: false });
        },
      ),
  );
}

export type Origin = { startedBy: StartedBy | null; submittedVia: SubmittedVia | null };

// The events that carry origin and the stages the credit report counts.
const ORIGIN_TYPES = [
  "application.created",
  "application.submitted",
  "application.in_process",
  "application.offer",
];

type OriginRow = { aggregate: string; type: string; payload: Record<string, unknown> };

// Folds an application's events (oldest first) into its origin: the latest value of each wins.
function foldOrigin(rows: readonly OriginRow[]): Origin {
  let startedBy: StartedBy | null = null;
  let submittedVia: SubmittedVia | null = null;
  for (const r of rows) {
    if (r.type === "application.created" && isStartedBy(r.payload.startedBy)) {
      startedBy = r.payload.startedBy;
    }
    if (r.type === "application.submitted" && isSubmittedVia(r.payload.submittedVia)) {
      submittedVia = r.payload.submittedVia;
    }
  }
  return { startedBy, submittedVia };
}

async function originRows(
  db: Db,
  candidateId: CandidateId,
  aggregate?: string,
): Promise<OriginRow[]> {
  return db
    .select({
      aggregate: domainEvent.aggregate,
      type: domainEvent.type,
      payload: domainEvent.payload,
    })
    .from(domainEvent)
    .where(
      and(
        eq(domainEvent.candidateId, candidateId),
        inArray(domainEvent.type, ORIGIN_TYPES),
        aggregate === undefined
          ? like(domainEvent.aggregate, "application:%")
          : eq(domainEvent.aggregate, aggregate),
      ),
    )
    .orderBy(domainEvent.position);
}

export async function readOrigin(
  db: Db,
  candidateId: CandidateId,
  applicationId: ApplicationId,
): Promise<Origin> {
  return foldOrigin(await originRows(db, candidateId, `application:${applicationId}`));
}

export type StageCounts = {
  applications: number;
  submitted: number;
  inProcess: number;
  offer: number;
};
export type CreditReport = Record<OriginBucket, StageCounts>;

const empty = (): StageCounts => ({ applications: 0, submitted: 0, inProcess: 0, offer: 0 });

// Per origin bucket, how many applications reached each stage (INB-010). The replied, screen and
// interview stages come with inbox classification (NS-164).
export async function readCreditReport(db: Db, candidateId: CandidateId): Promise<CreditReport> {
  const [apps, rows] = await Promise.all([
    db
      .select({ id: application.id })
      .from(application)
      .where(eq(application.candidateId, candidateId)),
    originRows(db, candidateId),
  ]);
  const byApp = new Map<string, OriginRow[]>();
  for (const r of rows) {
    const list = byApp.get(r.aggregate) ?? [];
    list.push(r);
    byApp.set(r.aggregate, list);
  }
  const report: CreditReport = {
    northstar: empty(),
    northstar_by_hand: empty(),
    outside: empty(),
    recruiter_inbound: empty(),
    unknown: empty(),
  };
  for (const app of apps) {
    const events = byApp.get(`application:${app.id}`) ?? [];
    const origin = foldOrigin(events);
    const counts = report[originBucket(origin.startedBy, origin.submittedVia)];
    const reached = (type: string) => events.some((e) => e.type === type);
    counts.applications += 1;
    if (reached("application.submitted")) counts.submitted += 1;
    if (reached("application.in_process")) counts.inProcess += 1;
    if (reached("application.offer")) counts.offer += 1;
  }
  return report;
}
