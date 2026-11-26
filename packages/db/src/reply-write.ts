import {
  type CandidateId,
  parseReplyPackage,
  replyContentSha256,
  replySubject,
} from "@northstar/domain";
import { and, eq } from "drizzle-orm";
import { type RequestError, type RequestResult, requestApproval } from "./approval-write.js";
import type { Db } from "./db.js";
import { replyDraft } from "./reply-schema.js";

// Files a checked reply draft with the Approval Gate and stores it (NS-237, RPL-002): Paul approves
// exactly the recipient, subject, thread headers and body a later writer puts in the Gmail draft.
// One message has one live reply (the subject is keyed by its Gmail id). Nothing here writes to
// Gmail. The Gate's own `approval.requested` event is the feed line; the body, recipient and
// subject never go into an event or span.

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
  // A reply carries no policy facts: it always waits for Paul (only application packages can
  // ever be auto-approved, ADR-0002).
  const filed = await requestApproval(db, {
    candidateId: input.candidateId,
    kind: "email_reply",
    subject: replySubject(reply.gmailMessageId),
    contentSha256: sha,
    facts: null,
    actor: "system",
    idempotencyKey: `reply:${reply.gmailMessageId}:${sha}`,
  });
  if (!filed.ok) return filed;
  // After the request, keyed by it: a run that stopped in between stores the draft on its rerun,
  // which replays the same request.
  const inserted = await db
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
      cites: reply.cites,
      followUps: reply.followUps,
      contentSha256: sha,
    })
    .onConflictDoNothing({ target: replyDraft.requestId })
    .returning({ id: replyDraft.id });
  return { ok: true, value: { ...filed.value, stored: inserted.length > 0 } };
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
    cites: row.cites,
    followUps: row.followUps,
    contentSha256: row.contentSha256,
  };
}
