import type { CandidateId, Result } from "@northstar/domain";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { mailLink } from "./mail-link-schema.js";
import { recruiterGrade } from "./recruiter-grade-schema.js";
import { recruiterRegrade } from "./recruiter-regrade-schema.js";
import { appendEvent, inSpan } from "./resilience-event.js";

// Paul's own letter for a graded recruiter message (NS-238 item 3, REC-003). It records what he
// thinks the grade should be, and nothing else: no draft, filing, send or archive follows from it.
// Slice 2 learns bounded weight adjustments from these rows.

export const LETTERS = ["A", "B", "C", "D", "F"] as const;
export type Letter = (typeof LETTERS)[number];

const GMAIL_ID = /^[0-9a-f]{1,32}$/;

export type RegradeError =
  | { kind: "InvalidRegrade"; fields: string[] }
  // No stored recruiter_grade for the message: there's nothing to regrade.
  | { kind: "NotGraded" };

export async function regradeRecruiterMessage(
  db: Db,
  input: { candidateId: CandidateId; gmailMessageId: string; grade: string },
): Promise<Result<{ recorded: boolean }, RegradeError>> {
  const fields: string[] = [];
  if (!GMAIL_ID.test(input.gmailMessageId)) fields.push("gmailMessageId");
  if (!(LETTERS as readonly string[]).includes(input.grade)) fields.push("grade");
  if (fields.length > 0) return { ok: false, error: { kind: "InvalidRegrade", fields } };
  const grade = input.grade as Letter;
  return inSpan("db.recruiter_regrade.record", { "northstar.recruiter.regrade": grade }, (span) =>
    db.transaction(async (tx) => {
      // The candidate's row lock serializes regrades, so two clicks can't both store one.
      await tx.execute(sql`select id from candidate where id = ${input.candidateId} for update`);
      const [graded] = await tx
        .select({ grade: recruiterGrade.grade })
        .from(recruiterGrade)
        .where(
          and(
            eq(recruiterGrade.candidateId, input.candidateId),
            eq(recruiterGrade.gmailMessageId, input.gmailMessageId),
          ),
        );
      if (!graded) return { ok: false as const, error: { kind: "NotGraded" as const } };
      const [current] = await tx
        .select({ grade: recruiterRegrade.grade })
        .from(recruiterRegrade)
        .where(
          and(
            eq(recruiterRegrade.candidateId, input.candidateId),
            eq(recruiterRegrade.gmailMessageId, input.gmailMessageId),
          ),
        )
        .orderBy(desc(recruiterRegrade.regradedAt), desc(recruiterRegrade.id))
        .limit(1);
      // The same letter as his current one: a repeat stores nothing.
      if (current?.grade === grade) return { ok: true as const, value: { recorded: false } };
      const [row] = await tx
        .insert(recruiterRegrade)
        .values({ candidateId: input.candidateId, gmailMessageId: input.gmailMessageId, grade })
        .returning({ id: recruiterRegrade.id, regradedAt: recruiterRegrade.regradedAt });
      if (!row) throw new Error("no regrade row written");
      await appendEvent(tx, span, {
        candidateId: input.candidateId,
        aggregate: `recruiter_regrade:${row.id}`,
        type: "recruiter.regraded",
        actor: "user",
        // The feed shows this reason: fixed words and two letters only.
        reason: `You regraded a recruiter email: ${graded.grade} to ${grade}`,
        payload: {
          gmailMessageId: input.gmailMessageId,
          systemGrade: graded.grade,
          grade,
        },
        // Each stored row is its own regrade.
        idempotencyKey: `recruiter_regrade:${row.id}`,
        at: row.regradedAt,
      });
      return { ok: true as const, value: { recorded: true } };
    }),
  );
}

// Paul's current letter per message, among the given messages, the candidate's own only.
export async function readRegrades(
  db: Db,
  candidateId: CandidateId,
  gmailMessageIds: readonly string[],
): Promise<Map<string, Letter>> {
  if (gmailMessageIds.length === 0) return new Map();
  const rows = await db
    .select({ gmailMessageId: recruiterRegrade.gmailMessageId, grade: recruiterRegrade.grade })
    .from(recruiterRegrade)
    .where(
      and(
        eq(recruiterRegrade.candidateId, candidateId),
        inArray(recruiterRegrade.gmailMessageId, [...gmailMessageIds]),
      ),
    )
    .orderBy(desc(recruiterRegrade.regradedAt), desc(recruiterRegrade.id));
  const out = new Map<string, Letter>();
  // Newest first: the first row per message is current.
  for (const r of rows)
    if (!out.has(r.gmailMessageId)) out.set(r.gmailMessageId, r.grade as Letter);
  return out;
}

// The Inbox shows threads, so Paul regrades a thread: its newest graded message gets his letter.
export async function regradeThread(
  db: Db,
  input: { candidateId: CandidateId; gmailThreadId: string; grade: string },
): Promise<Result<{ recorded: boolean }, RegradeError>> {
  if (!GMAIL_ID.test(input.gmailThreadId)) {
    return { ok: false, error: { kind: "InvalidRegrade", fields: ["gmailThreadId"] } };
  }
  const [newest] = await db
    .select({ gmailMessageId: recruiterGrade.gmailMessageId })
    .from(recruiterGrade)
    .innerJoin(
      mailLink,
      and(
        eq(mailLink.candidateId, recruiterGrade.candidateId),
        eq(mailLink.gmailMessageId, recruiterGrade.gmailMessageId),
      ),
    )
    .where(
      and(
        eq(recruiterGrade.candidateId, input.candidateId),
        eq(mailLink.gmailThreadId, input.gmailThreadId),
      ),
    )
    .orderBy(desc(mailLink.receivedAt), desc(mailLink.gmailMessageId))
    .limit(1);
  if (!newest) return { ok: false, error: { kind: "NotGraded" } };
  return regradeRecruiterMessage(db, {
    candidateId: input.candidateId,
    gmailMessageId: newest.gmailMessageId,
    grade: input.grade,
  });
}
