import type { CandidateId, Result } from "@northstar/domain";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db.js";
import { mailLink } from "./mail-link-schema.js";
import { recruiterGrade } from "./recruiter-grade-schema.js";
import { appendEvent, inSpan } from "./resilience-event.js";

// Recording a recruiter message's grade (NS-238, REC-001/002): the grade plain code decided
// (gradeRecruiterMessage in @northstar/sources), stored once per message with its feed event in one
// transaction. Codes and numbers only: no email text reaches the table, the event or the span.

const Reason = z.string().regex(/^(dealbreaker|[a-z_]+:[a-z_]+)$/);
export const GradeInput = z
  .object({
    grade: z.enum(["A", "B", "C", "D", "F"]),
    points: z.number().int().min(-50).max(50),
    reasons: z.array(Reason).min(1).max(12),
    confidence: z.enum(["normal", "low"]),
  })
  .strict();
export type GradeInput = z.infer<typeof GradeInput>;

const GMAIL_ID = /^[0-9a-f]{1,32}$/;

export type GradeError =
  | { kind: "InvalidGrade"; fields: string[] }
  // The mail loop never recorded this message, so there is nothing to grade.
  | { kind: "UnknownMessage" };

export async function recordRecruiterGrade(
  db: Db,
  input: { candidateId: CandidateId; gmailMessageId: string; grade: unknown },
): Promise<Result<{ recorded: boolean }, GradeError>> {
  const parsed = GradeInput.safeParse(input.grade);
  const fields = parsed.success
    ? []
    : [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "grade")))];
  if (!GMAIL_ID.test(input.gmailMessageId)) fields.unshift("gmailMessageId");
  if (!parsed.success || fields.length > 0) {
    return { ok: false, error: { kind: "InvalidGrade", fields } };
  }
  const g = parsed.data;
  return inSpan("db.recruiter_grade.record", { "northstar.recruiter.grade": g.grade }, (span) =>
    db.transaction(async (tx) => {
      const [link] = await tx
        .select({ id: mailLink.id })
        .from(mailLink)
        .where(
          and(
            eq(mailLink.candidateId, input.candidateId),
            eq(mailLink.gmailMessageId, input.gmailMessageId),
          ),
        );
      if (!link) return { ok: false as const, error: { kind: "UnknownMessage" as const } };
      const [row] = await tx
        .insert(recruiterGrade)
        .values({
          candidateId: input.candidateId,
          gmailMessageId: input.gmailMessageId,
          grade: g.grade,
          points: g.points,
          reasons: g.reasons,
          confidence: g.confidence,
        })
        .onConflictDoNothing({
          target: [recruiterGrade.candidateId, recruiterGrade.gmailMessageId],
        })
        .returning({ id: recruiterGrade.id, gradedAt: recruiterGrade.gradedAt });
      // Already graded: the first grade stands (a regrade is REC-003's, later).
      if (!row) return { ok: true as const, value: { recorded: false } };
      await appendEvent(tx, span, {
        candidateId: input.candidateId,
        aggregate: `recruiter_grade:${row.id}`,
        type: "recruiter.graded",
        actor: "system",
        // The feed shows this reason (no template): fixed words and the grade letter only.
        reason: `Graded a recruiter email: ${g.grade}${g.confidence === "low" ? " (little to go on)" : ""}`,
        payload: {
          gmailMessageId: input.gmailMessageId,
          grade: g.grade,
          confidence: g.confidence,
          reasons: g.reasons,
        },
        idempotencyKey: `recruiter_grade:${input.candidateId}:${input.gmailMessageId}`,
        at: row.gradedAt,
      });
      return { ok: true as const, value: { recorded: true } };
    }),
  );
}

export type StoredGrade = {
  gmailMessageId: string;
  grade: GradeInput["grade"];
  reasons: string[];
  confidence: GradeInput["confidence"];
};

// The stored grades among the given messages, the candidate's own only.
export async function readRecruiterGrades(
  db: Db,
  candidateId: CandidateId,
  gmailMessageIds: readonly string[],
): Promise<StoredGrade[]> {
  if (gmailMessageIds.length === 0) return [];
  const rows = await db
    .select({
      gmailMessageId: recruiterGrade.gmailMessageId,
      grade: recruiterGrade.grade,
      reasons: recruiterGrade.reasons,
      confidence: recruiterGrade.confidence,
    })
    .from(recruiterGrade)
    .where(
      and(
        eq(recruiterGrade.candidateId, candidateId),
        inArray(recruiterGrade.gmailMessageId, [...gmailMessageIds]),
      ),
    );
  return rows.map((r) => ({
    gmailMessageId: r.gmailMessageId,
    grade: r.grade as StoredGrade["grade"],
    reasons: r.reasons,
    confidence: r.confidence as StoredGrade["confidence"],
  }));
}
