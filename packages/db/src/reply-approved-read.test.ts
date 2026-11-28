import { CandidateId, type ReplyPackage } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideApprovals, undoDecision, withdrawApproval } from "./approval-write.js";
import type { Db } from "./db.js";
import { readApprovedReplies } from "./reply-approved-read.js";
import { claimDraft, recordDraft } from "./reply-ledger-write.js";
import { editReplyDraft, fileReplyDraft } from "./reply-write.js";
import { createTestDb, seedApplication, setGateClock } from "./test/pglite.js";

// The approved replies `funnel drafts` writes as Gmail drafts (NS-281 slice 1) on PGlite.
// Synthetic mail and invented ids only.

const T0 = new Date("2026-11-28T06:00:00.000Z");
// Past the Gate's 2-minute undo window.
const AFTER_UNDO = 3 * 60 * 1000;

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let messages = 0;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  candidateId = CandidateId.parse((await seedApplication(db, "submitted")).candidateId);
  await setGateClock(db, T0);
});
afterEach(() => close());

function reply(): ReplyPackage {
  messages += 1;
  const id = `18c3f0a2b4d6${String(messages).padStart(4, "0")}`;
  return {
    gmailMessageId: id,
    threadId: `${id}aa`,
    envelope: {
      to: "jo@acme.example",
      subject: "Re: Your application at Acme",
      inReplyTo: "<m2@acme.example>",
      references: ["<m1@acme.example>", "<m2@acme.example>"],
    },
    replyToOtherDomain: false,
    body: "Hi Jo, thank you for reaching out.",
    cites: [],
    followUps: [],
  };
}

async function filed(owner = candidateId): Promise<string> {
  const result = await fileReplyDraft(db, { candidateId: owner, reply: reply() });
  if (!result.ok) throw new Error(result.error.kind);
  return result.value.requestId;
}

async function approve(requestId: string, owner = candidateId): Promise<string> {
  const decided = await decideApprovals(db, {
    candidateId: owner,
    requestIds: [requestId],
    decision: "approve",
  });
  if (!decided.ok) throw new Error(decided.error.kind);
  const result = decided.value[0]?.result;
  if (!result?.ok) throw new Error("not decided");
  return result.value.decisionId;
}

const later = () => setGateClock(db, new Date(T0.getTime() + AFTER_UNDO));

describe("readApprovedReplies", () => {
  it("lists an approved reply once its undo window has passed", async () => {
    const requestId = await filed();
    const decisionId = await approve(requestId);
    await later();
    expect(await readApprovedReplies(db, candidateId)).toEqual([{ requestId, decisionId }]);
  });

  it("leaves out a pending reply and an approval still in its undo window", async () => {
    await filed();
    await approve(await filed());
    expect(await readApprovedReplies(db, candidateId)).toEqual([]);
  });

  it("leaves out a rejection, an undone approval and a withdrawn request", async () => {
    const rejected = await filed();
    const decided = await decideApprovals(db, {
      candidateId,
      requestIds: [rejected],
      decision: "reject",
      reason: "Not now",
    });
    if (!decided.ok) throw new Error(decided.error.kind);
    const undone = await approve(await filed());
    const undo = await undoDecision(db, { candidateId, decisionId: undone });
    if (!undo.ok) throw new Error(undo.error.kind);
    const withdrawn = await filed();
    await approve(withdrawn);
    await later();
    const closed = await withdrawApproval(db, { candidateId, requestId: withdrawn, by: "user" });
    if (!closed.ok) throw new Error(closed.error.kind);
    expect(await readApprovedReplies(db, candidateId)).toEqual([]);
  });

  it("lists only the edited request after Paul edits a reply and approves it", async () => {
    const original = await filed();
    const edited = await editReplyDraft(db, {
      candidateId,
      requestId: original,
      body: "Hi Jo, thanks. Happy to talk.",
    });
    if (!edited.ok) throw new Error(edited.error.kind);
    const decisionId = await approve(edited.value.requestId);
    await later();
    expect(await readApprovedReplies(db, candidateId)).toEqual([
      { requestId: edited.value.requestId, decisionId },
    ]);
  });

  it("leaves out a decision whose draft is recorded, but keeps one with only a claim", async () => {
    const written = await filed();
    const writtenDecision = await approve(written);
    const claimed = await filed();
    const claimedDecision = await approve(claimed);
    await later();
    await claimDraft(db, candidateId, writtenDecision);
    await recordDraft(db, candidateId, writtenDecision, "18c0ffee");
    await claimDraft(db, candidateId, claimedDecision);
    expect(await readApprovedReplies(db, candidateId)).toEqual([
      { requestId: claimed, decisionId: claimedDecision },
    ]);
  });

  it("leaves out another candidate's approved reply", async () => {
    const otherId = CandidateId.parse((await seedApplication(db, "submitted")).candidateId);
    const requestId = await filed(otherId);
    await approve(requestId, otherId);
    await later();
    expect([
      await readApprovedReplies(db, candidateId),
      (await readApprovedReplies(db, otherId)).map((r) => r.requestId),
    ]).toEqual([[], [requestId]]);
  });
});
