import {
  type CandidateId,
  err,
  ok,
  type PrepPlanContent,
  prepPlanContentSha256,
  prepPlanSubject,
  type Result,
} from "@northstar/domain";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type RequestError, requestApproval } from "./approval-write.js";
import type { Db } from "./db.js";
import type { PrepBlockKind } from "./interview-prep-write.js";
import {
  interviewDecision,
  interviewDetection,
  interviewPrepBlock,
  interviewPrepProposal,
} from "./interview-schema.js";
import { prepPlanRequest } from "./prep-plan-schema.js";
import { inSpan } from "./resilience-event.js";

// Prep plans through the Approval Gate (NS-241 slice 4, ADR-0031 item 3, CAL-003): Paul approves
// a stored proposal once per interview. The one entry point that files a `prep_plan` request; the
// plan row and the request commit together, and the row's foreign key pins the request's kind and
// hash. Ids, versions and times only.

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type PrepPlanFileError =
  | RequestError
  | { kind: "UnknownProposal" }
  // A reschedule replaced the interview the proposal was planned for.
  | { kind: "Superseded" }
  | { kind: "NotConfirmed" }
  // The planner placed nothing: there is nothing for Paul to approve.
  | { kind: "EmptyPlan" };

export type FiledPrepPlan = { requestId: string; replayed: boolean; stored: boolean };

const Uuid = z.string().uuid();

export async function requestPrepPlanApproval(
  db: Db,
  input: { candidateId: CandidateId; proposalId: string },
): Promise<Result<FiledPrepPlan, PrepPlanFileError>> {
  if (!Uuid.safeParse(input.proposalId).success) return err({ kind: "UnknownProposal" });
  return inSpan("db.prep_plan.request", {}, (span) =>
    db.transaction(async (tx) => {
      // The candidate lock interview-write.ts takes: no new version or decision slips in between
      // these checks and the request.
      await tx.execute(sql`select id from candidate where id = ${input.candidateId} for update`);
      const [proposal] = await tx
        .select({ id: interviewPrepProposal.id, detectionId: interviewPrepProposal.detectionId })
        .from(interviewPrepProposal)
        .where(
          and(
            eq(interviewPrepProposal.id, input.proposalId),
            eq(interviewPrepProposal.candidateId, input.candidateId),
          ),
        );
      if (!proposal) return err({ kind: "UnknownProposal" as const });
      const detection = await detectionIn(tx, input.candidateId, proposal.detectionId);
      if (!detection) return err({ kind: "UnknownProposal" as const });
      const current = await currentDetectionIn(tx, input.candidateId, detection);
      if (current?.id !== detection.id) return err({ kind: "Superseded" as const });
      if (!current.confirmed) return err({ kind: "NotConfirmed" as const });
      const blocks = await blocksIn(tx, input.candidateId, proposal.id);
      if (blocks.length === 0) return err({ kind: "EmptyPlan" as const });
      const content: PrepPlanContent = {
        proposalId: proposal.id,
        detectionId: detection.id,
        detectionVersion: detection.version,
        blocks,
      };
      const sha = prepPlanContentSha256(content);
      const scoped = tx as unknown as Db;
      // A plan carries no policy facts: it always waits for Paul (only application packages can
      // ever be auto-approved, ADR-0002).
      const filed = await requestApproval(scoped, {
        candidateId: input.candidateId,
        kind: "prep_plan",
        subject: prepPlanSubject(proposal.id),
        contentSha256: sha,
        facts: null,
        actor: "system",
        idempotencyKey: `prep_plan:${proposal.id}:${sha}`,
      });
      if (!filed.ok) return filed;
      const inserted = await scoped
        .insert(prepPlanRequest)
        .values({
          candidateId: input.candidateId,
          requestId: filed.value.requestId,
          proposalId: proposal.id,
          detectionId: detection.id,
          detectionVersion: detection.version,
          contentSha256: sha,
        })
        .onConflictDoNothing({ target: prepPlanRequest.requestId })
        .returning({ id: prepPlanRequest.id });
      span.setAttribute("northstar.prep_plan.replayed", filed.value.replayed);
      return ok({
        requestId: filed.value.requestId,
        replayed: filed.value.replayed,
        stored: inserted.length > 0,
      });
    }),
  );
}

export type DetectionRef = { detectionId: string; version: number };

// A filed plan as the writer reads it: what the request pins, and the interview as it is now.
export type StoredPrepPlan = {
  requestId: string;
  proposalId: string;
  contentSha256: string;
  blocks: { kind: PrepBlockKind; start: Date; end: Date }[];
  // The detection the plan was filed for, and the current one for the same event and application
  // (a reschedule makes a new version), with Paul's decision on it.
  filedFor: DetectionRef;
  current: (DetectionRef & { confirmed: boolean }) | null;
};

export async function readPrepPlan(
  db: Db,
  candidateId: CandidateId,
  requestId: string,
): Promise<StoredPrepPlan | null> {
  if (!Uuid.safeParse(requestId).success) return null;
  return inSpan("db.prep_plan.read", {}, async () => {
    const [row] = await db
      .select()
      .from(prepPlanRequest)
      .where(
        and(eq(prepPlanRequest.requestId, requestId), eq(prepPlanRequest.candidateId, candidateId)),
      );
    if (!row) return null;
    const detection = await detectionIn(db, candidateId, row.detectionId);
    if (!detection) return null;
    const current = await currentDetectionIn(db, candidateId, detection);
    return {
      requestId: row.requestId,
      proposalId: row.proposalId,
      contentSha256: row.contentSha256,
      blocks: await blocksIn(db, candidateId, row.proposalId),
      filedFor: { detectionId: row.detectionId, version: row.detectionVersion },
      current: current
        ? { detectionId: current.id, version: current.version, confirmed: current.confirmed }
        : null,
    };
  });
}

type DetectionRow = {
  id: string;
  calendarEventId: string;
  applicationId: string;
  version: number;
};

async function detectionIn(
  q: Db | Tx,
  candidateId: CandidateId,
  detectionId: string,
): Promise<DetectionRow | null> {
  const [row] = await q
    .select({
      id: interviewDetection.id,
      calendarEventId: interviewDetection.calendarEventId,
      applicationId: interviewDetection.applicationId,
      version: interviewDetection.version,
    })
    .from(interviewDetection)
    .where(
      and(eq(interviewDetection.id, detectionId), eq(interviewDetection.candidateId, candidateId)),
    );
  return row ?? null;
}

// The highest version for the same calendar event and application, and whether Paul confirmed it.
async function currentDetectionIn(
  q: Db | Tx,
  candidateId: CandidateId,
  detection: DetectionRow,
): Promise<{ id: string; version: number; confirmed: boolean } | null> {
  const [newest] = await q
    .select({ id: interviewDetection.id, version: interviewDetection.version })
    .from(interviewDetection)
    .where(
      and(
        eq(interviewDetection.candidateId, candidateId),
        eq(interviewDetection.calendarEventId, detection.calendarEventId),
        eq(interviewDetection.applicationId, detection.applicationId),
      ),
    )
    .orderBy(desc(interviewDetection.version))
    .limit(1);
  if (!newest) return null;
  const [decision] = await q
    .select({ decision: interviewDecision.decision })
    .from(interviewDecision)
    .where(
      and(
        eq(interviewDecision.candidateId, candidateId),
        eq(interviewDecision.detectionId, newest.id),
      ),
    );
  return { ...newest, confirmed: decision?.decision === "confirmed" };
}

async function blocksIn(
  q: Db | Tx,
  candidateId: CandidateId,
  proposalId: string,
): Promise<StoredPrepPlan["blocks"]> {
  const rows = await q
    .select({
      kind: interviewPrepBlock.kind,
      start: interviewPrepBlock.startsAt,
      end: interviewPrepBlock.endsAt,
    })
    .from(interviewPrepBlock)
    .where(
      and(
        eq(interviewPrepBlock.candidateId, candidateId),
        eq(interviewPrepBlock.proposalId, proposalId),
      ),
    )
    .orderBy(asc(interviewPrepBlock.startsAt));
  return rows.map((r) => ({ kind: r.kind as PrepBlockKind, start: r.start, end: r.end }));
}
