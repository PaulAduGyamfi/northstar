import { createHash, randomUUID } from "node:crypto";
import { type CandidateId, err, ok, type Result } from "@northstar/domain";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { type BankKind, bankAnswer, bankAnswerCitation, bankAnswerUse } from "./answer-schema.js";
import { type VerifyError, verifyApproval } from "./approval-write.js";
import type { Db } from "./db.js";
import { domainEvent } from "./schema.js";
import { story } from "./story-schema.js";

// The answer bank's only write paths (ANS-003, ANS-005, ANS-006, GH-59). Each write and its domain
// event go in one transaction (ADR-0012). Events carry ids, the canonical id, kind, version,
// confidence and counts: never the answer text, the form's question or a company name.

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type AnswerContent = { canonicalId: string; shortText: string; longText: string | null };

// What Paul approves: the SHA-256 of the canonical id and both texts, as JSON so no two contents
// share a hash. The caller hashes the same content when it asks the Gate (kind `answer`).
export function answerContentSha256(content: AnswerContent): string {
  const json = JSON.stringify([content.canonicalId, content.shortText, content.longText]);
  return createHash("sha256").update(json).digest("hex");
}

export type SaveAnswerInput = AnswerContent & {
  candidateId: CandidateId;
  // Chosen by the caller before it asked the Gate: the approval's subject is `answer:<id>`.
  answerId: string;
  kind: BankKind;
  // The Gate decision Paul made on this answer (ANS-005).
  decisionId: string;
  // The application the answer was approved for (ANS-006).
  applicationId: string;
  // Paul changed the draft before approving it; the stored text is his edited version.
  edited: boolean;
  // The matcher's confidence for the form question (NS-118), for the feed only.
  confidence: number;
  storyIds: string[];
  atomIds: string[];
  traceId: string | null;
};

export type InvalidAnswer = { kind: "InvalidAnswer"; fields: string[] };
export type DecidedByPolicy = { kind: "DecidedByPolicy" };
export type StoryNotApproved = { kind: "StoryNotApproved"; storyIds: string[] };
export type SaveAnswerError = InvalidAnswer | VerifyError | DecidedByPolicy | StoryNotApproved;

const Uuid = z.uuid();
const SaveShape = z.object({
  answerId: Uuid,
  applicationId: Uuid,
  canonicalId: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  kind: z.enum(["reusable_narrative", "company_specific"]),
  shortText: z.string().trim().min(1),
  longText: z.string().trim().min(1).nullable(),
  confidence: z.number().min(0).max(1),
  storyIds: z.array(Uuid),
  atomIds: z.array(Uuid),
});

async function appendEvent(
  tx: Tx,
  e: { candidateId: CandidateId; answerId: string; type: string; reason: string },
  payload: Record<string, unknown>,
  traceId: string | null,
  idempotencyKey: string,
): Promise<void> {
  await tx.insert(domainEvent).values({
    id: randomUUID(),
    candidateId: e.candidateId,
    aggregate: `bank_answer:${e.answerId}`,
    type: e.type,
    actor: "user",
    reason: e.reason,
    inputsSummary: "",
    payload,
    links: [],
    traceId,
    idempotencyKey,
    occurredAt: new Date(),
  });
}

// Saves an answer Paul approved into the bank (ANS-006): verified with the Gate first, then the
// answer as the next version for its canonical question, its citations, its first use and one
// answer.approved event. The same answer id again stores nothing and returns `saved: false`.
export async function saveApprovedAnswer(
  db: Db,
  input: SaveAnswerInput,
): Promise<Result<{ answerId: string; version: number; saved: boolean }, SaveAnswerError>> {
  const parsed = SaveShape.safeParse(input);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
    return err({ kind: "InvalidAnswer", fields });
  }
  // Fails closed: only a live approval of exactly this content, past its undo window, passes.
  const verified = await verifyApproval(db, {
    candidateId: input.candidateId,
    decisionId: input.decisionId,
    kind: "answer",
    subject: `answer:${input.answerId}`,
    contentSha256: answerContentSha256(input),
  });
  if (!verified.ok) return verified;
  // Answers are never auto-approvable (ANS-005); a policy decision here means something is wrong.
  if (verified.value.decidedBy !== "user") return err({ kind: "DecidedByPolicy" });

  const storyIds = [...new Set(input.storyIds)];
  const atomIds = [...new Set(input.atomIds)];
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ version: bankAnswer.version })
      .from(bankAnswer)
      .where(and(eq(bankAnswer.id, input.answerId), eq(bankAnswer.candidateId, input.candidateId)));
    if (existing) return ok({ answerId: input.answerId, version: existing.version, saved: false });

    // Only stories Paul approved may be cited (ADR-0004); drafts can still change.
    if (storyIds.length > 0) {
      const approved = await tx
        .select({ id: story.id })
        .from(story)
        .where(
          and(
            eq(story.candidateId, input.candidateId),
            eq(story.status, "approved"),
            inArray(story.id, storyIds),
          ),
        );
      const approvedIds = new Set(approved.map((s) => s.id));
      const missing = storyIds.filter((id) => !approvedIds.has(id));
      if (missing.length > 0) return err({ kind: "StoryNotApproved", storyIds: missing });
    }

    const [latest] = await tx
      .select({ version: bankAnswer.version })
      .from(bankAnswer)
      .where(
        and(
          eq(bankAnswer.candidateId, input.candidateId),
          eq(bankAnswer.canonicalId, input.canonicalId),
        ),
      )
      .orderBy(desc(bankAnswer.version))
      .limit(1);
    const version = (latest?.version ?? 0) + 1;
    await tx.insert(bankAnswer).values({
      id: input.answerId,
      candidateId: input.candidateId,
      canonicalId: input.canonicalId,
      kind: input.kind,
      version,
      shortText: input.shortText,
      longText: input.longText,
      approvalDecisionId: verified.value.decisionId,
    });
    const citations = [
      ...storyIds.map((storyId) => ({ storyId, atomId: null })),
      ...atomIds.map((atomId) => ({ storyId: null, atomId })),
    ];
    if (citations.length > 0) {
      await tx.insert(bankAnswerCitation).values(
        citations.map((c) => ({
          candidateId: input.candidateId,
          answerId: input.answerId,
          ...c,
        })),
      );
    }
    await tx.insert(bankAnswerUse).values({
      candidateId: input.candidateId,
      answerId: input.answerId,
      applicationId: input.applicationId,
      how: "approved",
      edited: input.edited,
    });
    await appendEvent(
      tx,
      {
        candidateId: input.candidateId,
        answerId: input.answerId,
        type: "answer.approved",
        reason: "Paul approved an answer for the answer bank",
      },
      {
        answerId: input.answerId,
        canonicalId: input.canonicalId,
        kind: input.kind,
        version,
        applicationId: input.applicationId,
        decisionId: verified.value.decisionId,
        edited: input.edited,
        confidence: input.confidence,
        storyCount: storyIds.length,
        atomCount: atomIds.length,
      },
      input.traceId,
      `answer-approved:${input.answerId}`,
    );
    return ok({ answerId: input.answerId, version, saved: true });
  });
}

export type BankAnswerView = AnswerContent & {
  answerId: string;
  kind: BankKind;
  version: number;
  storyIds: string[];
  atomIds: string[];
  // Uses of every version of this canonical question's answer (ANS-003 "used N×").
  useCount: number;
};

// The bank's answer to one canonical question: its newest approved version. Null when none.
export async function readBankAnswer(
  db: Db,
  candidateId: CandidateId,
  canonicalId: string,
): Promise<BankAnswerView | null> {
  const [row] = await db
    .select()
    .from(bankAnswer)
    .where(and(eq(bankAnswer.candidateId, candidateId), eq(bankAnswer.canonicalId, canonicalId)))
    .orderBy(desc(bankAnswer.version))
    .limit(1);
  if (!row) return null;
  const cites = await db
    .select({ storyId: bankAnswerCitation.storyId, atomId: bankAnswerCitation.atomId })
    .from(bankAnswerCitation)
    .where(
      and(eq(bankAnswerCitation.candidateId, candidateId), eq(bankAnswerCitation.answerId, row.id)),
    );
  const [uses] = await db
    .select({ n: count() })
    .from(bankAnswerUse)
    .innerJoin(bankAnswer, eq(bankAnswer.id, bankAnswerUse.answerId))
    .where(
      and(eq(bankAnswerUse.candidateId, candidateId), eq(bankAnswer.canonicalId, canonicalId)),
    );
  return {
    answerId: row.id,
    canonicalId: row.canonicalId,
    kind: row.kind as BankKind,
    version: row.version,
    shortText: row.shortText,
    longText: row.longText,
    storyIds: cites.flatMap((c) => (c.storyId === null ? [] : [c.storyId])),
    atomIds: cites.flatMap((c) => (c.atomId === null ? [] : [c.atomId])),
    useCount: uses?.n ?? 0,
  };
}

// Records that a banked answer went into another application unchanged (ANS-003). Once per answer
// and application: a repeat records nothing and writes no second event.
export async function recordAnswerReuse(
  db: Db,
  input: {
    candidateId: CandidateId;
    answerId: string;
    applicationId: string;
    confidence: number;
    traceId: string | null;
  },
): Promise<{ recorded: boolean }> {
  return db.transaction(async (tx) => {
    const [answer] = await tx
      .select({ canonicalId: bankAnswer.canonicalId, kind: bankAnswer.kind })
      .from(bankAnswer)
      .where(and(eq(bankAnswer.id, input.answerId), eq(bankAnswer.candidateId, input.candidateId)));
    if (!answer) throw new Error("no such answer in the bank");
    const inserted = await tx
      .insert(bankAnswerUse)
      .values({
        candidateId: input.candidateId,
        answerId: input.answerId,
        applicationId: input.applicationId,
        how: "reused",
        edited: false,
      })
      .onConflictDoNothing({ target: [bankAnswerUse.answerId, bankAnswerUse.applicationId] })
      .returning({ id: bankAnswerUse.id });
    if (inserted.length === 0) return { recorded: false };
    await appendEvent(
      tx,
      {
        candidateId: input.candidateId,
        answerId: input.answerId,
        type: "answer.reused",
        reason: "A banked answer was reused in an application",
      },
      {
        answerId: input.answerId,
        canonicalId: answer.canonicalId,
        kind: answer.kind,
        applicationId: input.applicationId,
        confidence: input.confidence,
      },
      input.traceId,
      `answer-reused:${input.answerId}:${input.applicationId}`,
    );
    return { recorded: true };
  });
}
