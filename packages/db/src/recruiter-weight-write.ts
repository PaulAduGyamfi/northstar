import {
  type CandidateId,
  learnRecruiterWeights,
  type RecruiterGradeReason,
  type RecruiterWeights,
} from "@northstar/domain";
import type { Span } from "@opentelemetry/api";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "./db.js";
import { recruiterGrade } from "./recruiter-grade-schema.js";
import { recruiterRegrade } from "./recruiter-regrade-schema.js";
import { recruiterWeight } from "./recruiter-weight-schema.js";
import { appendEvent } from "./resilience-event.js";

// Recruiter grading's learned adjustments (NS-238 item 3 slice 2, REC-003). The rule is plain code
// in @northstar/domain (learnRecruiterWeights); this file feeds it Paul's current regrades and
// stores each change as a new version, visible in the feed. Nothing here drafts, sends or archives.

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// The adjustments as stored: two parallel arrays, in the reason list's order.
function toRow(w: RecruiterWeights): { reasons: string[]; adjustments: number[] } {
  const entries = Object.entries(w) as [RecruiterGradeReason, number][];
  return { reasons: entries.map(([r]) => r), adjustments: entries.map(([, a]) => a) };
}

function fromRow(reasons: readonly string[], adjustments: readonly number[]): RecruiterWeights {
  const w: RecruiterWeights = {};
  reasons.forEach((r, i) => {
    const a = adjustments[i];
    if (a !== undefined) w[r as RecruiterGradeReason] = a;
  });
  return w;
}

const sameWeights = (a: RecruiterWeights, b: RecruiterWeights): boolean =>
  JSON.stringify(toRow(a)) === JSON.stringify(toRow(b));

async function newest(db: Db | Tx, candidateId: CandidateId) {
  const [row] = await db
    .select({ reasons: recruiterWeight.reasons, adjustments: recruiterWeight.adjustments })
    .from(recruiterWeight)
    .where(eq(recruiterWeight.candidateId, candidateId))
    .orderBy(desc(recruiterWeight.position))
    .limit(1);
  return row ? fromRow(row.reasons, row.adjustments) : {};
}

// Relearns from every message Paul regraded (his newest letter each) and stores a version only when
// the result differs from the newest. Called inside the regrade's transaction, under the
// candidate's row lock, so two regrades can't both store the same change.
export async function refreshRecruiterWeights(
  tx: Tx,
  span: Span,
  candidateId: CandidateId,
): Promise<{ changed: number }> {
  const rows = await tx
    .select({
      gmailMessageId: recruiterRegrade.gmailMessageId,
      paulGrade: recruiterRegrade.grade,
      systemGrade: recruiterGrade.grade,
      reasons: recruiterGrade.reasons,
    })
    .from(recruiterRegrade)
    .innerJoin(
      recruiterGrade,
      and(
        eq(recruiterGrade.candidateId, recruiterRegrade.candidateId),
        eq(recruiterGrade.gmailMessageId, recruiterRegrade.gmailMessageId),
      ),
    )
    .where(eq(recruiterRegrade.candidateId, candidateId))
    .orderBy(desc(recruiterRegrade.position));
  // Newest first: the first row per message is his current letter.
  const current = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!current.has(r.gmailMessageId)) current.set(r.gmailMessageId, r);
  const learned = learnRecruiterWeights([...current.values()]);
  const before = await newest(tx, candidateId);
  if (sameWeights(before, learned)) return { changed: 0 };
  // The reasons whose adjustment moved, with the new value (0: no longer adjusted).
  const changes: Record<string, number> = {};
  for (const r of new Set([...Object.keys(before), ...Object.keys(learned)])) {
    const was = before[r as RecruiterGradeReason] ?? 0;
    const now = learned[r as RecruiterGradeReason] ?? 0;
    if (was !== now) changes[r] = now;
  }
  const [row] = await tx
    .insert(recruiterWeight)
    .values({ candidateId, ...toRow(learned), regrades: current.size })
    .returning({ id: recruiterWeight.id, learnedAt: recruiterWeight.learnedAt });
  if (!row) throw new Error("no recruiter weight row written");
  const changed = Object.keys(changes).length;
  span.setAttribute("northstar.recruiter.weights_changed", changed);
  await appendEvent(tx, span, {
    candidateId,
    aggregate: `recruiter_weight:${row.id}`,
    type: "recruiter.weights_adjusted",
    actor: "system",
    // The feed shows this reason: fixed words and a count only.
    reason: `Adjusted recruiter grading from your regrades: ${changed} ${changed === 1 ? "change" : "changes"}`,
    // Reason codes and whole numbers only.
    payload: { changes, regrades: current.size },
    idempotencyKey: `recruiter_weight:${row.id}`,
    at: row.learnedAt,
  });
  return { changed };
}

// The newest learned adjustments, for the grader; empty until Paul's regrades teach it something.
export async function readRecruiterWeights(
  db: Db,
  candidateId: CandidateId,
): Promise<RecruiterWeights> {
  return newest(db, candidateId);
}
