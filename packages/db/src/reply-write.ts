import {
  type CandidateId,
  parseReplyPackage,
  replyContentSha256,
  replySubject,
} from "@northstar/domain";
import { and, eq, inArray, notExists } from "drizzle-orm";
import { approvalRequest } from "./approval-schema.js";
import { type RequestError, type RequestResult, requestApproval } from "./approval-write.js";
import type { Db } from "./db.js";
import { replyDraft } from "./reply-schema.js";

// Files a checked reply draft with the Approval Gate and stores it (NS-237, RPL-002): Paul approves
// exactly the recipient, subject, thread headers and body a later writer puts in the Gmail draft.
// One message has one live reply (the subject is keyed by its Gmail id). Nothing here writes to
// Gmail. The Gate's own `approval.requested` event is the feed line; the body, recipient and
// subject never go into an event, span or error.

export type FiledReply = RequestResult & { stored: boolean };

export async function fileReplyDraft(
  db: Db,
  input: { candidateId: CandidateId; reply: unknown },
): Promise<{ ok: true; value: FiledReply } | { ok: false; error: RequestError }> {
  const parsed = parseReplyPackage(input.reply);
  if (!parsed.ok) {
    return { ok: false, error: { kind: "InvalidRequest", fields: parsed.error.fields } };
  }
  const reply = parsed.value;
  const sha = replyContentSha256(reply);
  // One transaction: the request and the draft behind it commit together, so Paul's queue never
  // holds a reply request with nothing to show (the Gate's own transaction nests as a savepoint).
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    // A reply carries no policy facts: it always waits for Paul (only application packages can
    // ever be auto-approved, ADR-0002).
    const filed = await requestApproval(scoped, {
      candidateId: input.candidateId,
      kind: "email_reply",
      subject: replySubject(reply.gmailMessageId),
      contentSha256: sha,
      facts: null,
      actor: "system",
      idempotencyKey: `reply:${reply.gmailMessageId}:${sha}`,
    });
    if (!filed.ok) return filed;
    let stored: boolean;
    try {
      const inserted = await scoped
        .insert(replyDraft)
        .values({
          candidateId: input.candidateId,
          requestId: filed.value.requestId,
          gmailMessageId: reply.gmailMessageId,
          threadId: reply.threadId,
          toAddress: reply.envelope.to,
          subject: reply.envelope.subject,
          inReplyTo: reply.envelope.inReplyTo,
          references: reply.envelope.references,
          body: reply.body,
          replyToOtherDomain: reply.replyToOtherDomain,
          cites: reply.cites,
          followUps: reply.followUps,
          contentSha256: sha,
        })
        .onConflictDoNothing({ target: replyDraft.requestId })
        .returning({ id: replyDraft.id });
      stored = inserted.length > 0;
    } catch {
      // A fresh error with no cause: the driver's message lists the insert's parameters, which
      // are the body and the recipient's address.
      throw new Error("reply_draft insert failed");
    }
    return { ok: true as const, value: { ...filed.value, stored } };
  });
}

// The stored draft behind a Gate request, for the approval view and the later Gmail writer.
export async function readReplyDraft(db: Db, candidateId: CandidateId, requestId: string) {
  const [row] = await db
    .select()
    .from(replyDraft)
    .where(and(eq(replyDraft.candidateId, candidateId), eq(replyDraft.requestId, requestId)));
  if (!row) return null;
  return {
    requestId: row.requestId,
    gmailMessageId: row.gmailMessageId,
    threadId: row.threadId,
    envelope: {
      to: row.toAddress,
      subject: row.subject,
      inReplyTo: row.inReplyTo,
      references: row.references,
    },
    body: row.body,
    replyToOtherDomain: row.replyToOtherDomain,
    cites: row.cites,
    followUps: row.followUps,
    contentSha256: row.contentSha256,
  };
}

// The ids among requestIds that are the candidate's email_reply requests with no stored draft
// (NS-237 slice 2): the approval queue never lets Paul approve one, since there is nothing behind
// it to show or to write.
export async function missingReplyDrafts(
  db: Db,
  candidateId: CandidateId,
  requestIds: readonly string[],
): Promise<string[]> {
  if (requestIds.length === 0) return [];
  const rows = await db
    .select({ id: approvalRequest.id })
    .from(approvalRequest)
    .where(
      and(
        eq(approvalRequest.candidateId, candidateId),
        eq(approvalRequest.kind, "email_reply"),
        inArray(approvalRequest.id, [...requestIds]),
        notExists(
          db
            .select({ one: replyDraft.id })
            .from(replyDraft)
            .where(eq(replyDraft.requestId, approvalRequest.id)),
        ),
      ),
    );
  return rows.map((r) => r.id);
}

// The ids among requestIds whose stored reply draft goes to another domain than the sender's
// (NS-237 slice 2): the queue approves one of these only on its own, never in a batch, so Paul has
// it in front of him with its warning.
export async function otherDomainReplies(
  db: Db,
  candidateId: CandidateId,
  requestIds: readonly string[],
): Promise<string[]> {
  if (requestIds.length === 0) return [];
  const rows = await db
    .select({ id: replyDraft.requestId })
    .from(replyDraft)
    .where(
      and(
        eq(replyDraft.candidateId, candidateId),
        eq(replyDraft.replyToOtherDomain, true),
        inArray(replyDraft.requestId, [...requestIds]),
      ),
    );
  return rows.map((r) => r.id);
}
