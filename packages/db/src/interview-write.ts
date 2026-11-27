import { type CandidateId, INTERVIEW_FORMATS, type Result } from "@northstar/domain";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db.js";
import { interviewDecision, interviewDetection } from "./interview-schema.js";
import { appendEvent, inSpan } from "./resilience-event.js";
import { application } from "./schema.js";

// Detected interviews and Paul's decision on each (NS-240 slice 2, CAL-002). A detection comes from
// plain code over a calendar event (detectInterview in @northstar/inbox); invites aren't
// authenticated, so it is only a proposal until Paul confirms it, and neither a detection nor a
// decision ever moves an application's status. Times, a format and a count only: no title,
// description, address or name reaches a table, an event or a span.

const EVENT_ID = /^[A-Za-z0-9_]{1,200}$/;
// Anyone can send Paul an invite, so an attacker could move one event over and over, or send many.
// Each event keeps at most this many versions (also a CHECK), and at most this many new detections
// are stored a day.
export const MAX_DETECTION_VERSIONS = 10;
export const MAX_DETECTIONS_PER_DAY = 50;
// A date that isn't one (new Date(NaN)) is refused under its own field name.
const validDate = z.date().refine((d) => !Number.isNaN(d.getTime()));

export const DetectionInput = z
  .object({
    applicationId: z.string().uuid(),
    calendarEventId: z.string().regex(EVENT_ID),
    format: z.enum(INTERVIEW_FORMATS),
    start: validDate,
    end: validDate,
    interviewerCount: z.number().int().min(0).max(50),
  })
  .strict()
  .refine((d) => d.end.getTime() > d.start.getTime(), { path: ["end"] });
export type DetectionInput = z.infer<typeof DetectionInput>;

export type DetectionError =
  | { kind: "InvalidDetection"; fields: string[] }
  // Not one of this candidate's applications.
  | { kind: "UnknownApplication" }
  // The event has moved MAX_DETECTION_VERSIONS times: nothing more is stored for it.
  | { kind: "TooManyChanges" }
  // MAX_DETECTIONS_PER_DAY new detections were stored in the last day.
  | { kind: "DailyLimit" };

// Words for the feed line: fixed, from the format code only.
const FORMAT_WORDS: Record<(typeof INTERVIEW_FORMATS)[number], string> = {
  phone_screen: "phone screen",
  technical: "technical interview",
  system_design: "system design interview",
  behavioral: "behavioral interview",
  onsite: "onsite interview",
  other: "interview",
};

export async function recordInterviewDetection(
  db: Db,
  input: { candidateId: CandidateId; detection: unknown },
): Promise<Result<{ recorded: boolean; detectionId: string }, DetectionError>> {
  const parsed = DetectionInput.safeParse(input.detection);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "detection")))];
    return { ok: false, error: { kind: "InvalidDetection", fields } };
  }
  const d = parsed.data;
  return inSpan("db.interview.detect", { "northstar.interview.format": d.format }, (span) =>
    db.transaction(async (tx) => {
      const [app] = await tx
        .select({ id: application.id })
        .from(application)
        .where(
          and(eq(application.id, d.applicationId), eq(application.candidateId, input.candidateId)),
        );
      if (!app) return { ok: false as const, error: { kind: "UnknownApplication" as const } };
      // One writer at a time per application, so two can't store the same version.
      await tx.execute(
        sql`select id from application where id = ${d.applicationId} and candidate_id = ${input.candidateId} for update`,
      );
      const sameEvent = and(
        eq(interviewDetection.candidateId, input.candidateId),
        eq(interviewDetection.calendarEventId, d.calendarEventId),
        eq(interviewDetection.applicationId, d.applicationId),
      );
      const [current] = await tx
        .select()
        .from(interviewDetection)
        .where(sameEvent)
        .orderBy(desc(interviewDetection.version))
        .limit(1);
      if (current) {
        // Paul dismissed this event: a later move doesn't bring it back.
        const [dismissed] = await tx
          .select({ id: interviewDecision.id })
          .from(interviewDecision)
          .innerJoin(interviewDetection, eq(interviewDecision.detectionId, interviewDetection.id))
          .where(and(sameEvent, eq(interviewDecision.decision, "dismissed")))
          .limit(1);
        const unchanged =
          current.startsAt.getTime() === d.start.getTime() &&
          current.endsAt.getTime() === d.end.getTime() &&
          current.format === d.format &&
          current.interviewerCount === d.interviewerCount;
        if (dismissed || unchanged) {
          return { ok: true as const, value: { recorded: false, detectionId: current.id } };
        }
      }
      const version = (current?.version ?? 0) + 1;
      if (version > MAX_DETECTION_VERSIONS) {
        return { ok: false as const, error: { kind: "TooManyChanges" as const } };
      }
      const [{ count } = { count: 0 }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(interviewDetection)
        .where(
          and(
            eq(interviewDetection.candidateId, input.candidateId),
            gt(interviewDetection.detectedAt, sql`now() - interval '1 day'`),
          ),
        );
      if (count >= MAX_DETECTIONS_PER_DAY) {
        return { ok: false as const, error: { kind: "DailyLimit" as const } };
      }
      const [row] = await tx
        .insert(interviewDetection)
        .values({
          candidateId: input.candidateId,
          calendarEventId: d.calendarEventId,
          applicationId: d.applicationId,
          format: d.format,
          startsAt: d.start,
          endsAt: d.end,
          interviewerCount: d.interviewerCount,
          version,
        })
        .returning({ id: interviewDetection.id, detectedAt: interviewDetection.detectedAt });
      if (!row) throw new Error("interview detection not stored");
      const moved = version > 1;
      await appendEvent(tx, span, {
        candidateId: input.candidateId,
        // The application's aggregate, so the feed names its job; the type isn't application.*,
        // which the feed reads as a status move.
        aggregate: `application:${d.applicationId}`,
        // Only the first detection asks "confirm it"; a move says so more quietly.
        type: moved ? "interview.rescheduled" : "interview.detected",
        actor: "system",
        reason: moved
          ? `A possible ${FORMAT_WORDS[d.format]} on your calendar moved: confirm the new time`
          : `Found a possible ${FORMAT_WORDS[d.format]} on your calendar: confirm it`,
        payload: {
          // The application's timeline finds its events by this field.
          applicationId: d.applicationId,
          detectionId: row.id,
          version,
          format: d.format,
          startsAt: d.start.toISOString(),
          endsAt: d.end.toISOString(),
          interviewerCount: d.interviewerCount,
        },
        idempotencyKey: `interview_detection:${row.id}`,
        at: row.detectedAt,
      });
      return { ok: true as const, value: { recorded: true, detectionId: row.id } };
    }),
  );
}

export type InterviewDecisionKind = "confirmed" | "dismissed";

export type DecisionError =
  | { kind: "UnknownDetection" }
  // A reschedule replaced this detection: Paul decides on the current time, never an old one.
  | { kind: "Superseded" }
  // Already decided the other way: a decision is made once (a new invite is a new detection).
  | { kind: "AlreadyDecided"; decision: InterviewDecisionKind };

// Paul's confirm or dismiss on one detection, once. Never moves the application's status.
export async function decideInterview(
  db: Db,
  input: { candidateId: CandidateId; detectionId: string; decision: InterviewDecisionKind },
): Promise<Result<{ recorded: boolean }, DecisionError>> {
  if (!z.string().uuid().safeParse(input.detectionId).success) {
    return { ok: false, error: { kind: "UnknownDetection" } };
  }
  return inSpan("db.interview.decide", { "northstar.interview.decision": input.decision }, (span) =>
    db.transaction(async (tx) => {
      const [detection] = await tx
        .select({
          id: interviewDetection.id,
          applicationId: interviewDetection.applicationId,
          calendarEventId: interviewDetection.calendarEventId,
          version: interviewDetection.version,
        })
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
      const [row] = await tx
        .insert(interviewDecision)
        .values({
          candidateId: input.candidateId,
          detectionId: detection.id,
          decision: input.decision,
        })
        .onConflictDoNothing({ target: [interviewDecision.detectionId] })
        .returning({ decidedAt: interviewDecision.decidedAt });
      if (!row) {
        const [earlier] = await tx
          .select({ decision: interviewDecision.decision })
          .from(interviewDecision)
          .where(eq(interviewDecision.detectionId, detection.id));
        // The conflict means the row exists (append-only, READ COMMITTED sees the winner).
        if (!earlier) throw new Error("interview decision vanished");
        const decision = earlier.decision as InterviewDecisionKind;
        if (decision === input.decision) return { ok: true as const, value: { recorded: false } };
        return { ok: false as const, error: { kind: "AlreadyDecided" as const, decision } };
      }
      await appendEvent(tx, span, {
        candidateId: input.candidateId,
        aggregate: `application:${detection.applicationId}`,
        type: `interview.${input.decision}`,
        actor: "user",
        reason:
          input.decision === "confirmed"
            ? "You confirmed an interview from your calendar"
            : "You dismissed a calendar event that wasn't an interview",
        payload: {
          applicationId: detection.applicationId,
          detectionId: detection.id,
          decision: input.decision,
        },
        idempotencyKey: `interview_decision:${detection.id}`,
        at: row.decidedAt,
      });
      return { ok: true as const, value: { recorded: true } };
    }),
  );
}

export type StoredInterview = {
  detectionId: string;
  applicationId: string;
  calendarEventId: string;
  format: (typeof INTERVIEW_FORMATS)[number];
  start: Date;
  end: Date;
  interviewerCount: number;
  decision: InterviewDecisionKind | null;
};

// The candidate's current detections by start time: for each event and application only the highest
// version (a reschedule supersedes the old time), each with Paul's decision or null.
export async function listInterviews(db: Db, candidateId: CandidateId): Promise<StoredInterview[]> {
  const rows = await db
    .select()
    .from(interviewDetection)
    .where(eq(interviewDetection.candidateId, candidateId))
    .orderBy(asc(interviewDetection.version));
  const current = new Map<string, (typeof rows)[number]>();
  // Lowest version first, so the highest per event and application is the one left.
  for (const r of rows) current.set(`${r.calendarEventId}|${r.applicationId}`, r);
  const kept = [...current.values()];
  const decisions =
    kept.length === 0
      ? []
      : await db
          .select({
            detectionId: interviewDecision.detectionId,
            decision: interviewDecision.decision,
          })
          .from(interviewDecision)
          .where(
            and(
              eq(interviewDecision.candidateId, candidateId),
              inArray(
                interviewDecision.detectionId,
                kept.map((r) => r.id),
              ),
            ),
          );
  const decided = new Map(
    decisions.map((d) => [d.detectionId, d.decision as InterviewDecisionKind]),
  );
  return kept
    .map((r) => ({
      detectionId: r.id,
      applicationId: r.applicationId,
      calendarEventId: r.calendarEventId,
      format: r.format as StoredInterview["format"],
      start: r.startsAt,
      end: r.endsAt,
      interviewerCount: r.interviewerCount,
      decision: decided.get(r.id) ?? null,
    }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}
