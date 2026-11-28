import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerDraft } from "./answer-draft-schema.js";
import {
  type AnswerDraftInput,
  bankApprovedAnswer,
  fileAnswerDraft,
  readAnswerDraft,
  readApprovedAnswerDrafts,
} from "./answer-draft-write.js";
import { readBankAnswer } from "./answer-write.js";
import { approvalRequest } from "./approval-schema.js";
import { decideApprovals, listPendingApprovals, withdrawApproval } from "./approval-write.js";
import type { Db } from "./db.js";
import { createTestDb, seedApplication, setGateClock, sqlState } from "./test/pglite.js";

// Answer drafts filed with the Gate and banked once approved (NS-281 slice 3) on PGlite.
// Synthetic text and invented ids only.

const RESTRICT_VIOLATION = "23001";
const FOREIGN_KEY_VIOLATION = "23503";
const T0 = new Date("2026-11-28T06:00:00.000Z");
const AFTER_UNDO = 3 * 60 * 1000;

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let applicationId: string;
let answers = 0;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "queued");
  candidateId = CandidateId.parse(seeded.candidateId);
  applicationId = seeded.applicationId;
  await setGateClock(db, T0);
});
afterEach(() => close());

function draft(over: Partial<AnswerDraftInput> = {}): AnswerDraftInput {
  answers += 1;
  return {
    candidateId,
    answerId: `00000000-0000-4000-8000-${String(answers).padStart(12, "0")}`,
    applicationId,
    fieldName: "question_101",
    canonicalId: "why-this-company",
    kind: "company_specific",
    shortText: "I led a billing migration and want to do that work here.",
    longText: null,
    confidence: 0.9,
    storyIds: [],
    atomIds: [],
    ...over,
  };
}

async function approve(requestId: string): Promise<string> {
  const decided = await decideApprovals(db, {
    candidateId,
    requestIds: [requestId],
    decision: "approve",
  });
  if (!decided.ok) throw new Error(decided.error.kind);
  const result = decided.value[0]?.result;
  if (!result?.ok) throw new Error("not decided");
  return result.value.decisionId;
}

const later = () => setGateClock(db, new Date(T0.getTime() + AFTER_UNDO));

describe("fileAnswerDraft", () => {
  it("files the draft as a pending answer request and stores what Paul approves", async () => {
    const input = draft();
    const filed = await fileAnswerDraft(db, input);
    if (!filed.ok) throw new Error(filed.error.kind);
    const stored = await readAnswerDraft(db, candidateId, filed.value.requestId);
    expect([
      filed.value.stored,
      (await listPendingApprovals(db, candidateId)).map((p) => [p.kind, p.subject]),
      stored?.shortText,
      stored?.answerId,
      stored?.applicationId,
    ]).toEqual([
      true,
      [["answer", `answer:${input.answerId}`]],
      input.shortText,
      input.answerId,
      applicationId,
    ]);
  });

  it("stores nothing new when the same draft is filed twice", async () => {
    const input = draft();
    const first = await fileAnswerDraft(db, input);
    const second = await fileAnswerDraft(db, input);
    if (!first.ok || !second.ok) throw new Error("not filed");
    const rows = await db.select({ id: answerDraft.id }).from(answerDraft);
    expect([second.value.stored, second.value.requestId, rows.length]).toEqual([
      false,
      first.value.requestId,
      1,
    ]);
  });

  it("refuses a draft of the wrong shape by field, storing nothing", async () => {
    const filed = await fileAnswerDraft(db, draft({ shortText: " ", canonicalId: "Bad Id" }));
    const rows = await db.select({ id: answerDraft.id }).from(answerDraft);
    expect([filed.ok ? null : filed.error, rows.length]).toEqual([
      { kind: "InvalidRequest", fields: ["canonicalId", "shortText"] },
      0,
    ]);
  });

  it("never auto-approves: the request carries no policy facts", async () => {
    const filed = await fileAnswerDraft(db, draft());
    if (!filed.ok) throw new Error(filed.error.kind);
    const [request] = await db
      .select({ facts: approvalRequest.facts })
      .from(approvalRequest)
      .where(eq(approvalRequest.id, filed.value.requestId));
    expect([filed.value.decision, request?.facts]).toEqual([null, null]);
  });

  it("refuses an application that isn't the candidate's, storing nothing", async () => {
    const other = await seedApplication(db, "queued");
    let state: string | undefined;
    try {
      await fileAnswerDraft(db, draft({ applicationId: other.applicationId }));
    } catch (e) {
      state = (e as Error).message;
    }
    const rows = await db.select({ id: answerDraft.id }).from(answerDraft);
    expect([state, rows.length]).toEqual(["answer_draft insert failed", 0]);
  });
});

describe("answer_draft is append-only", () => {
  it("refuses an update, a delete and a truncate", async () => {
    const filed = await fileAnswerDraft(db, draft());
    if (!filed.ok) throw new Error(filed.error.kind);
    const states = [
      await sqlState(db.execute(sql`update answer_draft set short_text = 'changed'`)),
      await sqlState(db.execute(sql`delete from answer_draft`)),
      await sqlState(db.execute(sql`truncate answer_draft`)),
    ];
    expect(states).toEqual([RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION]);
  });

  it("refuses a row with no Gate request pinning its content", async () => {
    const state = await sqlState(
      db.insert(answerDraft).values({
        candidateId,
        requestId: "00000000-0000-4000-8000-00000000abcd",
        answerId: "00000000-0000-4000-8000-00000000abce",
        applicationId,
        fieldName: "question_1",
        canonicalId: "why-this-company",
        kind: "company_specific",
        shortText: "Text",
        longText: null,
        confidence: 0.5,
        storyIds: [],
        atomIds: [],
        contentSha256: "a".repeat(64),
      }),
    );
    expect(state).toBe(FOREIGN_KEY_VIOLATION);
  });
});

describe("readApprovedAnswerDrafts and bankApprovedAnswer", () => {
  it("lists an approved draft past its undo window, banks it once, then lists it no more", async () => {
    const input = draft();
    const filed = await fileAnswerDraft(db, input);
    if (!filed.ok) throw new Error(filed.error.kind);
    const decisionId = await approve(filed.value.requestId);
    const inWindow = await readApprovedAnswerDrafts(db, candidateId);
    await later();
    const listed = await readApprovedAnswerDrafts(db, candidateId);
    const first = await bankApprovedAnswer(db, {
      candidateId,
      requestId: filed.value.requestId,
      decisionId,
    });
    const second = await bankApprovedAnswer(db, {
      candidateId,
      requestId: filed.value.requestId,
      decisionId,
    });
    const banked = await readBankAnswer(db, candidateId, input.canonicalId);
    expect([
      inWindow,
      listed,
      first.ok ? first.value.saved : first.error,
      second.ok ? second.value.saved : second.error,
      banked?.shortText,
      await readApprovedAnswerDrafts(db, candidateId),
    ]).toEqual([
      [],
      [{ requestId: filed.value.requestId, decisionId }],
      true,
      false,
      input.shortText,
      [],
    ]);
  });

  it("leaves out a withdrawn request and refuses to bank a pending one", async () => {
    const withdrawn = await fileAnswerDraft(db, draft());
    const pending = await fileAnswerDraft(db, draft());
    if (!withdrawn.ok || !pending.ok) throw new Error("not filed");
    const decisionId = await approve(withdrawn.value.requestId);
    await later();
    const closed = await withdrawApproval(db, {
      candidateId,
      requestId: withdrawn.value.requestId,
      by: "user",
    });
    if (!closed.ok) throw new Error(closed.error.kind);
    const banked = await bankApprovedAnswer(db, {
      candidateId,
      requestId: pending.value.requestId,
      decisionId,
    });
    expect([await readApprovedAnswerDrafts(db, candidateId), banked.ok]).toEqual([[], false]);
  });

  it("keeps the answer's text out of the error when the bank's insert fails", async () => {
    // Another candidate already banked an answer under the same id: the bank's primary key refuses
    // this one inside saveApprovedAnswer.
    const shared = draft();
    const otherSeed = await seedApplication(db, "queued");
    const otherId = CandidateId.parse(otherSeed.candidateId);
    const theirs = await fileAnswerDraft(db, {
      ...shared,
      candidateId: otherId,
      applicationId: otherSeed.applicationId,
    });
    const mine = await fileAnswerDraft(db, shared);
    if (!theirs.ok || !mine.ok) throw new Error("not filed");
    const theirDecision = await decideApprovals(db, {
      candidateId: otherId,
      requestIds: [theirs.value.requestId],
      decision: "approve",
    });
    if (!theirDecision.ok) throw new Error(theirDecision.error.kind);
    const theirDecisionId = theirDecision.value[0]?.result.ok
      ? theirDecision.value[0].result.value.decisionId
      : "";
    const myDecisionId = await approve(mine.value.requestId);
    await later();
    const banked = await bankApprovedAnswer(db, {
      candidateId: otherId,
      requestId: theirs.value.requestId,
      decisionId: theirDecisionId,
    });
    let message = "";
    try {
      await bankApprovedAnswer(db, {
        candidateId,
        requestId: mine.value.requestId,
        decisionId: myDecisionId,
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect([banked.ok, message, message.includes(shared.shortText)]).toEqual([
      true,
      "bank_answer insert failed",
      false,
    ]);
  });

  it("answers NotFound for a request with no stored draft", async () => {
    const banked = await bankApprovedAnswer(db, {
      candidateId,
      requestId: "00000000-0000-4000-8000-00000000dead",
      decisionId: "00000000-0000-4000-8000-00000000beef",
    });
    expect(banked).toEqual({ ok: false, error: { kind: "NotFound" } });
  });
});
