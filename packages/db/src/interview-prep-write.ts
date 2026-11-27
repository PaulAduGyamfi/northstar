import {
  type CandidateId,
  type PrepInterval,
  planPrepBlocks,
  type Result,
} from "@northstar/domain";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db.js";
import {
  interviewDecision,
  interviewDetection,
  interviewPrepBlock,
  interviewPrepProposal,
} from "./interview-schema.js";
import { appendEvent, inSpan } from "./resilience-event.js";

// Proposed prep for a confirmed interview (NS-241 slice 1, CAL-003). Code works the times out with
// planPrepBlocks over the stored interview; the caller gives only Paul's busy time, working hours,
// time zone and the clock. Stored once per detection, append-only. A proposal is never a calendar
// write: that goes through the Approval Gate in a later slice (ADR-0002). Times and counts only:
// no title, address, name or time zone reaches a row, an event or a span.

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// A date that isn't one (new Date(NaN)) is refused under its own field name.
const validDate = z.date().refine((d) => !Number.isNaN(d.getTime()));
const knownZone = (zone: string) => {
  try {
    // An unknown zone throws a RangeError: refused here, never planned as UTC.
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

export const PrepRequest = z
  .object({
    // Other events and growth blocks; bounded so one call can't make the planner loop for long.
    busy: z.array(z.object({ start: validDate, end: validDate }).strict()).max(500),
    // Minutes after local midnight in timeZone, start before end (the planner's own rule).
    workingHours: z
      .object({ start: z.number().int().min(0), end: z.number().int().max(1440) })
      .strict()
      .refine((w) => w.start < w.end, { path: ["start"] }),
    timeZone: z.string().min(1).max(64).refine(knownZone),
    now: validDate,
  })
  .strict();
export type PrepRequest = z.infer<typeof PrepRequest>;

export type PrepError =
  | { kind: "InvalidInput"; fields: string[] }
  | { kind: "UnknownDetection" }
  // A reschedule replaced this detection: prep follows the current time, never an old one.
  | { kind: "Superseded" }
  // Paul hasn't confirmed this interview (no decision yet, or he dismissed it).
  | { kind: "NotConfirmed" };

export type PrepBlockKind = "prep" | "warm_up";
export type StoredPrepProposal = {
  proposalId: string;
  detectionId: string;
  blocks: { kind: PrepBlockKind; start: Date; end: Date }[];
  missingPrep: number;
  warmUpMissing: boolean;
  proposedAt: Date;
};

// The feed line, from counts and fixed words only.
export function prepReason(prepBlocks: number, warmUp: boolean): string {
  const prep =
    prepBlocks === 0
      ? "no prep blocks"
      : prepBlocks === 1
        ? "1 prep block"
        : `${prepBlocks} prep blocks`;
  return `Proposed ${prep} ${warmUp ? "and a warm-up" : "and no warm-up"} for your interview`;
}

export async function proposeInterviewPrep(
  db: Db,
  input: { candidateId: CandidateId; detectionId: string; request: unknown },
): Promise<Result<{ recorded: boolean; proposal: StoredPrepProposal }, PrepError>> {
  const parsed = PrepRequest.safeParse(input.request);
  if (!parsed.success) {
    // Field names only: busy times and the zone are Paul's data.
    const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "request")))];
    return { ok: false, error: { kind: "InvalidInput", fields } };
  }
  if (!z.string().uuid().safeParse(input.detectionId).success) {
    return { ok: false, error: { kind: "UnknownDetection" } };
  }
  const request = parsed.data;
  return inSpan("db.interview.prep_propose", {}, (span) =>
    db.transaction(async (tx) => {
      // The same candidate lock as interview-write.ts, so a new version or decision can't slip in
      // between these checks and the insert, and two proposers store one proposal.
      await tx.execute(sql`select id from candidate where id = ${input.candidateId} for update`);
      const [detection] = await tx
        .select()
        .from(interviewDetection)
        .where(
          and(
            eq(interviewDetection.id, input.detectionId),
            eq(interviewDetection.candidateId, input.candidateId),
          ),
        );
      if (!detection) return { ok: false as const, error: { kind: "UnknownDetection" as const } };
      const [newer] = await tx
        .select({ id: interviewDetection.id })
        .from(interviewDetection)
        .where(
          and(
            eq(interviewDetection.candidateId, input.candidateId),
            eq(interviewDetection.calendarEventId, detection.calendarEventId),
            eq(interviewDetection.applicationId, detection.applicationId),
            gt(interviewDetection.version, detection.version),
          ),
        )
        .limit(1);
      if (newer) return { ok: false as const, error: { kind: "Superseded" as const } };
      const [decision] = await tx
        .select({ decision: interviewDecision.decision })
        .from(interviewDecision)
        .where(
          and(
            eq(interviewDecision.candidateId, input.candidateId),
            eq(interviewDecision.detectionId, detection.id),
          ),
        );
      if (decision?.decision !== "confirmed") {
        return { ok: false as const, error: { kind: "NotConfirmed" as const } };
      }
      // Already proposed: the first proposal stands and the plan isn't worked out again.
      const earlier = await readProposalIn(tx, input.candidateId, detection.id);
      if (earlier) return { ok: true as const, value: { recorded: false, proposal: earlier } };

      const plan = planPrepBlocks({
        interview: { start: detection.startsAt, end: detection.endsAt },
        busy: request.busy,
        workingHours: request.workingHours,
        timeZone: request.timeZone,
        now: request.now,
      });
      const [row] = await tx
        .insert(interviewPrepProposal)
        .values({
          candidateId: input.candidateId,
          detectionId: detection.id,
          missingPrep: plan.missingPrep,
          warmUpMissing: plan.warmUpMissing,
        })
        .returning();
      if (!row) throw new Error("prep proposal not stored");
      const blocks: { kind: PrepBlockKind; interval: PrepInterval }[] = [
        ...plan.blocks.map((interval) => ({ kind: "prep" as const, interval })),
        ...(plan.warmUp ? [{ kind: "warm_up" as const, interval: plan.warmUp }] : []),
      ];
      if (blocks.length > 0) {
        await tx.insert(interviewPrepBlock).values(
          blocks.map((b) => ({
            candidateId: input.candidateId,
            proposalId: row.id,
            kind: b.kind,
            startsAt: b.interval.start,
            endsAt: b.interval.end,
          })),
        );
      }
      span.setAttributes({
        "northstar.interview.prep_blocks": plan.blocks.length,
        "northstar.interview.prep_missing": plan.missingPrep,
        "northstar.interview.warm_up": plan.warmUp !== null,
      });
      await appendEvent(tx, span, {
        candidateId: input.candidateId,
        aggregate: `application:${detection.applicationId}`,
        type: "interview.prep_proposed",
        actor: "system",
        reason: prepReason(plan.blocks.length, plan.warmUp !== null),
        payload: {
          applicationId: detection.applicationId,
          detectionId: detection.id,
          proposalId: row.id,
          prepBlocks: plan.blocks.length,
          missingPrep: plan.missingPrep,
          warmUp: plan.warmUp !== null,
        },
        idempotencyKey: `interview_prep:${detection.id}`,
        at: row.proposedAt,
      });
      const proposal = await readProposalIn(tx, input.candidateId, detection.id);
      if (!proposal) throw new Error("prep proposal vanished");
      return { ok: true as const, value: { recorded: true, proposal } };
    }),
  );
}

// The stored proposal for one of the candidate's detections, with its blocks by start time.
export async function readPrepProposal(
  db: Db,
  candidateId: CandidateId,
  detectionId: string,
): Promise<StoredPrepProposal | null> {
  if (!z.string().uuid().safeParse(detectionId).success) return null;
  return readProposalIn(db, candidateId, detectionId);
}

async function readProposalIn(
  q: Db | Tx,
  candidateId: CandidateId,
  detectionId: string,
): Promise<StoredPrepProposal | null> {
  const [proposal] = await q
    .select()
    .from(interviewPrepProposal)
    .where(
      and(
        eq(interviewPrepProposal.candidateId, candidateId),
        eq(interviewPrepProposal.detectionId, detectionId),
      ),
    )
    .orderBy(desc(interviewPrepProposal.proposedAt))
    .limit(1);
  if (!proposal) return null;
  const blocks = await q
    .select()
    .from(interviewPrepBlock)
    .where(
      and(
        eq(interviewPrepBlock.candidateId, candidateId),
        eq(interviewPrepBlock.proposalId, proposal.id),
      ),
    )
    .orderBy(asc(interviewPrepBlock.startsAt));
  return {
    proposalId: proposal.id,
    detectionId: proposal.detectionId,
    blocks: blocks.map((b) => ({
      kind: b.kind as PrepBlockKind,
      start: b.startsAt,
      end: b.endsAt,
    })),
    missingPrep: proposal.missingPrep,
    warmUpMissing: proposal.warmUpMissing,
    proposedAt: proposal.proposedAt,
  };
}
