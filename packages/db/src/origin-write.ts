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

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

import { application, domainEvent, job } from "./schema.js";

// Application origin (NS-188, INB-007) and the credit report (INB-010). Origin is stored in
// events, never in a column: `startedBy` in `application.created` (written here, with the row),
// `submittedVia` in the move to `submitted` (transitionApplication). Email matching writes neither.

export type JobNotFound = { kind: "JobNotFound" };
// The key already names another event (or this one for another job): nothing is created.
export type IdempotencyKeyReused = { kind: "IdempotencyKeyReused" };
// Applications start in the pipeline (INB-007 b: `submitted_via` is written with the move to
// `submitted`), except one Paul sent outside Northstar, which starts at `submitted` by hand.
export type InvalidStart = { kind: "InvalidStart" };

const ENTRY_STATUSES: readonly ApplicationStatus[] = [
  "discovered",
  "scored",
  "queued",
  "package_ready",
  "awaiting_approval",
];

const UNIQUE_VIOLATION = "23505";
const codeOf = (error: unknown): unknown =>
  (error as { code?: unknown }).code ?? (error as { cause?: { code?: unknown } }).cause?.code;

type CreateInput = {
  candidateId: CandidateId;
  jobId: string;
  status: ApplicationStatus;
  startedBy: StartedBy;
  // Only with status `submitted`, and only `by_hand`.
  submittedVia?: SubmittedVia;
  idempotencyKey: string;
};
type Created = { applicationId: string; replayed: boolean };
type CreateError = JobNotFound | IdempotencyKeyReused | InvalidStart;

// The application an earlier call with this key created, if the key names exactly that.
async function replayOf(
  tx: Tx | Db,
  input: CreateInput,
): Promise<Result<Created, IdempotencyKeyReused> | null> {
  const [before] = await tx
    .select({
      aggregate: domainEvent.aggregate,
      type: domainEvent.type,
      payload: domainEvent.payload,
    })
    .from(domainEvent)
    .where(
      and(
        eq(domainEvent.candidateId, input.candidateId),
        eq(domainEvent.idempotencyKey, input.idempotencyKey),
      ),
    );
  if (!before) return null;
  const same =
    before.type === "application.created" &&
    before.aggregate.startsWith("application:") &&
    before.payload.jobId === input.jobId;
  if (!same) return err({ kind: "IdempotencyKeyReused" });
  return ok({ applicationId: before.aggregate.slice("application:".length), replayed: true });
}

// Creates an application with its first event and who started it, in one transaction. Repeating
// the same idempotency key hands back the first application and writes nothing.
export async function createApplication(
  db: Db,
  input: CreateInput,
): Promise<Result<Created, CreateError>> {
  // Checked at run time too: these values become the origin forever (ADR-0012).
  if (!isStartedBy(input.startedBy)) return err({ kind: "InvalidStart" });
  const byHand = input.status === "submitted" && input.submittedVia === "by_hand";
  const entry = ENTRY_STATUSES.includes(input.status) && input.submittedVia === undefined;
  if (!byHand && !entry) return err({ kind: "InvalidStart" });
  return inSpan(
    "db.application.create",
    { "northstar.origin.started_by": input.startedBy },
    async (span) => {
      try {
        return await db.transaction(async (tx): Promise<Result<Created, CreateError>> => {
          const replay = await replayOf(tx, input);
          if (replay) return replay;
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
            payload: {
              to: input.status,
              jobId: input.jobId,
              startedBy: input.startedBy,
              ...(byHand ? { submittedVia: "by_hand" } : {}),
            },
            idempotencyKey: input.idempotencyKey,
            at: row.createdAt,
          });
          return ok({ applicationId: row.id, replayed: false });
        });
      } catch (error) {
        // Two calls racing with one key: the loser's event hits the unique key; hand back the
        // winner's application, as transitionApplication does.
        if (codeOf(error) !== UNIQUE_VIOLATION) throw error;
        const replay = await replayOf(db, input);
        if (replay) return replay;
        throw error;
      }
    },
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
    // Created already submitted (Paul applied outside Northstar), or moved there.
    const carries = r.type === "application.created" || r.type === "application.submitted";
    if (carries && isSubmittedVia(r.payload.submittedVia)) {
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
    const createdSubmitted = events.some(
      (e) => e.type === "application.created" && e.payload.to === "submitted",
    );
    if (reached("application.submitted") || createdSubmitted) counts.submitted += 1;
    if (reached("application.in_process")) counts.inProcess += 1;
    if (reached("application.offer")) counts.offer += 1;
  }
  return report;
}
