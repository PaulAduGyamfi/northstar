import type { CandidateId, Result } from "@northstar/domain";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { answerDraft } from "./answer-draft-schema.js";
import type { BankKind } from "./answer-schema.js";
import { answerContentSha256, type SaveAnswerError, saveApprovedAnswer } from "./answer-write.js";
import { type RequestError, type RequestResult, requestApproval } from "./approval-write.js";
import type { Db } from "./db.js";

// Answer drafts filed with the Approval Gate (NS-281 slice 3, ANS-004, ANS-005): a drafted answer
// for a narrative form question waits for Paul as an `answer` request, and once he approves it the
// stored draft is banked through saveApprovedAnswer (ANS-006). Nothing here drafts or submits.
// The texts are drafted from Paul's stories and atoms: never in an event, span or error.

export type AnswerDraftInput = {
  candidateId: CandidateId;
  // Chosen by the caller: the request's subject is `answer:<answerId>`, the banked answer's id.
  answerId: string;
  applicationId: string;
  fieldName: string;
  canonicalId: string;
  kind: BankKind;
  shortText: string;
  longText: string | null;
  confidence: number;
  storyIds: readonly string[];
  atomIds: readonly string[];
};

const Uuid = z.uuid();
const NO_CONTROL = /^[^\p{Cc}]*$/u;
const DraftShape = z.object({
  answerId: Uuid,
  applicationId: Uuid,
  fieldName: z.string().min(1).max(200).regex(NO_CONTROL),
  canonicalId: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  kind: z.enum(["reusable_narrative", "company_specific"]),
  shortText: z.string().trim().min(1).max(5000),
  longText: z.string().trim().min(1).max(10000).nullable(),
  confidence: z.number().min(0).max(1),
  storyIds: z.array(Uuid).max(50),
  atomIds: z.array(Uuid).max(50),
});

export type FiledAnswer = RequestResult & { stored: boolean };

// The Gate's hash (answerContentSha256) covers what is banked as the answer: its question, kind,
// texts and application. The citations and confidence are fixed by this row instead, which is
// append-only, one per request, and the only thing bankApprovedAnswer reads. A new draft for the
// same question (after a rejection, say) needs a new answer id: the answer id is unique here.
// Files the draft with the Gate and stores it, in one transaction: Paul's Queue never holds an
// answer request with nothing to show. The request carries no policy facts, so it always waits for
// him (answers are never auto-approvable, ANS-005). Filing the same draft again stores nothing.
export async function fileAnswerDraft(
  db: Db,
  input: AnswerDraftInput,
): Promise<{ ok: true; value: FiledAnswer } | { ok: false; error: RequestError }> {
  const parsed = DraftShape.safeParse(input);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
    return { ok: false, error: { kind: "InvalidRequest", fields } };
  }
  const d = parsed.data;
  const sha = answerContentSha256({
    canonicalId: d.canonicalId,
    kind: d.kind,
    shortText: d.shortText,
    longText: d.longText,
    applicationId: d.applicationId,
  });
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const filed = await requestApproval(scoped, {
      candidateId: input.candidateId,
      kind: "answer",
      subject: `answer:${d.answerId}`,
      contentSha256: sha,
      facts: null,
      actor: "system",
      idempotencyKey: `answer:${d.answerId}:${sha}`,
    });
    if (!filed.ok) return filed;
    let stored: boolean;
    try {
      const inserted = await scoped
        .insert(answerDraft)
        .values({
          candidateId: input.candidateId,
          requestId: filed.value.requestId,
          answerId: d.answerId,
          applicationId: d.applicationId,
          fieldName: d.fieldName,
          canonicalId: d.canonicalId,
          kind: d.kind,
          shortText: d.shortText,
          longText: d.longText,
          confidence: d.confidence,
          storyIds: [...new Set(d.storyIds)],
          atomIds: [...new Set(d.atomIds)],
          contentSha256: sha,
        })
        .onConflictDoNothing({ target: answerDraft.requestId })
        .returning({ id: answerDraft.id });
      stored = inserted.length > 0;
    } catch {
      // A fresh error with no cause: the driver's message lists the insert's parameters, which
      // hold the answer's text.
      throw new Error("answer_draft insert failed");
    }
    return { ok: true as const, value: { ...filed.value, stored } };
  });
}

export type StoredAnswerDraft = {
  requestId: string;
  answerId: string;
  applicationId: string;
  fieldName: string;
  canonicalId: string;
  kind: BankKind;
  shortText: string;
  longText: string | null;
  confidence: number;
  storyIds: string[];
  atomIds: string[];
  contentSha256: string;
};

// The stored draft behind one of the candidate's `answer` requests, or null.
export async function readAnswerDraft(
  db: Db,
  candidateId: CandidateId,
  requestId: string,
): Promise<StoredAnswerDraft | null> {
  if (!Uuid.safeParse(requestId).success) return null;
  const [row] = await db
    .select()
    .from(answerDraft)
    .where(and(eq(answerDraft.candidateId, candidateId), eq(answerDraft.requestId, requestId)));
  if (!row) return null;
  return {
    requestId: row.requestId,
    answerId: row.answerId,
    applicationId: row.applicationId,
    fieldName: row.fieldName,
    canonicalId: row.canonicalId,
    kind: row.kind as BankKind,
    shortText: row.shortText,
    longText: row.longText,
    confidence: row.confidence,
    storyIds: row.storyIds,
    atomIds: row.atomIds,
    contentSha256: row.contentSha256,
  };
}

// At most this many approved drafts a run, newest first.
export const APPROVED_ANSWER_LIMIT = 50;

export type ApprovedAnswerDraft = { requestId: string; decisionId: string };

type Row = { request_id: string; decision_id: string };

// The answer drafts Paul approved that aren't banked yet, by readApprovedReplies' rule: the newest
// live decision is an approval past its undo window by the Gate's clock, not undone, the request
// not withdrawn, and no bank answer under the draft's answer id. Ids only.
export async function readApprovedAnswerDrafts(
  db: Db,
  candidateId: CandidateId,
): Promise<ApprovedAnswerDraft[]> {
  const result = (await db.execute(sql`
    select ad.request_id, d.id as decision_id
    from answer_draft ad
    join approval_request r
      on r.id = ad.request_id and r.candidate_id = ad.candidate_id and r.kind = 'answer'
    join lateral (
      select d.id, d.decision, d.effective_at
      from approval_decision d
      where d.request_id = r.id and d.candidate_id = r.candidate_id
        and d.effective_at <= northstar_gate_now()
        and not exists (select 1 from approval_undo u where u.decision_id = d.id)
      order by d.effective_at desc
      limit 1
    ) d on true
    where ad.candidate_id = ${candidateId}
      and d.decision = 'approved'
      and not exists (
        select 1 from approval_withdrawal w
        where w.request_id = r.id and w.candidate_id = r.candidate_id
      )
      -- Already banked: the bank answer's id is the draft's answer id.
      and not exists (
        select 1 from bank_answer b
        where b.id = ad.answer_id and b.candidate_id = ad.candidate_id
      )
    order by d.effective_at desc, ad.request_id
    limit ${APPROVED_ANSWER_LIMIT}
  `)) as unknown as { rows: Row[] };
  return result.rows.map((row) => ({ requestId: row.request_id, decisionId: row.decision_id }));
}

export type BankDraftError = { kind: "NotFound" } | SaveAnswerError;

// Banks one approved draft: the stored row is what Paul approved (its hash is the request's, by
// the foreign key), and saveApprovedAnswer verifies the approval again at the moment it stores.
// Banking it again stores nothing (`saved: false`).
export async function bankApprovedAnswer(
  db: Db,
  input: { candidateId: CandidateId; requestId: string; decisionId: string },
): Promise<Result<{ answerId: string; version: number; saved: boolean }, BankDraftError>> {
  const draft = await readAnswerDraft(db, input.candidateId, input.requestId);
  if (draft === null) return { ok: false, error: { kind: "NotFound" } };
  try {
    return await saveApprovedAnswer(db, {
      candidateId: input.candidateId,
      answerId: draft.answerId,
      kind: draft.kind,
      canonicalId: draft.canonicalId,
      shortText: draft.shortText,
      longText: draft.longText,
      decisionId: input.decisionId,
      applicationId: draft.applicationId,
      // Paul approves the draft as filed; an edit would be a new request (NS-203).
      edited: false,
      confidence: draft.confidence,
      storyIds: draft.storyIds,
      atomIds: draft.atomIds,
      traceId: null,
    });
  } catch {
    // A fresh error with no cause: a driver error (a race on the bank answer's id, say) lists the
    // insert's parameters, which hold the answer's text.
    throw new Error("bank_answer save failed");
  }
}
