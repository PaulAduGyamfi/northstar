import {
  type ApplicationStatus,
  type CandidateId,
  NUDGE_STAGES,
  type NudgeCandidate,
} from "@northstar/domain";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "./db.js";
import { readMailClassifications } from "./mail-classification-write.js";
import { mailLink } from "./mail-link-schema.js";
import { replyDraft } from "./reply-schema.js";
import { inSpan } from "./resilience-event.js";
import { application } from "./schema.js";

// What the follow-up nudge check needs (RPL-004, NS-237 slice 3), read-only: each of the
// candidate's applications in a nudge stage with its status, when it last moved, its newest linked
// message from a verified sender and whether a reply draft is already filed for that message. Ids and times only, never
// a subject, sender or body.

const NUDGE_STATUSES: ApplicationStatus[] = Object.values(NUDGE_STAGES).flat();

export async function readNudgeCandidates(
  db: Db,
  candidateId: CandidateId,
): Promise<NudgeCandidate[]> {
  return inSpan("db.nudge.candidates", {}, async (span) => {
    const apps = await db
      .select({ id: application.id, status: application.status, movedAt: application.updatedAt })
      .from(application)
      .where(
        and(eq(application.candidateId, candidateId), inArray(application.status, NUDGE_STATUSES)),
      );
    span.setAttribute("northstar.nudge.applications", apps.length);
    if (apps.length === 0) return [];
    // Newest first, so the first row seen per application is its newest linked message.
    const links = await db
      .select({
        applicationId: mailLink.applicationId,
        gmailMessageId: mailLink.gmailMessageId,
        threadId: mailLink.gmailThreadId,
        receivedAt: mailLink.receivedAt,
      })
      .from(mailLink)
      .where(
        and(
          eq(mailLink.candidateId, candidateId),
          isNotNull(mailLink.applicationId),
          // Only mail from a verified sender (INB-011) counts: it is the one a nudge replies to and
          // the one that resets the silence. A tag can be written to by anyone, so unverified mail
          // could pick the recipient or hold nudges off.
          eq(mailLink.senderVerified, true),
          inArray(
            mailLink.applicationId,
            apps.map((a) => a.id),
          ),
        ),
      )
      // Two messages received in the same instant are ordered by Gmail id, only so the pick is fixed.
      .orderBy(desc(mailLink.receivedAt), desc(mailLink.gmailMessageId));
    const newest = new Map<string, (typeof links)[number]>();
    for (const l of links) {
      if (l.applicationId !== null && !newest.has(l.applicationId)) newest.set(l.applicationId, l);
    }
    const messageIds = [...newest.values()].map((l) => l.gmailMessageId);
    const filed =
      messageIds.length === 0
        ? []
        : await db
            .select({ gmailMessageId: replyDraft.gmailMessageId })
            .from(replyDraft)
            .where(
              and(
                eq(replyDraft.candidateId, candidateId),
                inArray(replyDraft.gmailMessageId, messageIds),
              ),
            );
    const filedIds = new Set(filed.map((f) => f.gmailMessageId));
    // The newest messages' stored kinds (NS-261): a review or an unclassified message has none.
    const kinds = new Map(
      (await readMailClassifications(db, candidateId, messageIds))
        .filter((c) => c.outcome === "classified")
        .map((c) => [c.gmailMessageId, c.kind]),
    );
    return apps.map((a) => {
      const mail = newest.get(a.id) ?? null;
      return {
        applicationId: a.id,
        status: a.status as ApplicationStatus,
        lastMoveAt: a.movedAt,
        lastMail:
          mail === null
            ? null
            : {
                gmailMessageId: mail.gmailMessageId,
                threadId: mail.threadId,
                receivedAt: mail.receivedAt,
                // The stored classification (NS-261), or null until the message is classified.
                kind: kinds.get(mail.gmailMessageId) ?? null,
              },
        replyFiled: mail !== null && filedIds.has(mail.gmailMessageId),
      };
    });
  });
}
