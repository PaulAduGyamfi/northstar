import type { CandidateId } from "@northstar/domain";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { mailClassification } from "./mail-classification-schema.js";
import { mailLinkDecision } from "./mail-link-decision-schema.js";
import { mailLink } from "./mail-link-schema.js";
import { recruiterGrade } from "./recruiter-grade-schema.js";

// What `funnel inbox` (NS-238 item 1) still has to do after linking: read-only, ids and counts
// only, the candidate's own rows only.

export type UnclassifiedMail = { mailLinkId: string; gmailMessageId: string };

// Recorded messages with no classification that Paul hasn't dismissed, newest first, at most
// `limit`. Linked and queued alike: recruiter mail usually matches no application, and grading
// needs its kind. Newest first so a message that keeps being passed over can't hold back new mail.
export async function readUnclassifiedMail(
  db: Pick<Db, "select">,
  candidateId: CandidateId,
  limit: number,
): Promise<UnclassifiedMail[]> {
  return db
    .select({ mailLinkId: mailLink.id, gmailMessageId: mailLink.gmailMessageId })
    .from(mailLink)
    .leftJoin(
      mailClassification,
      and(
        eq(mailClassification.candidateId, mailLink.candidateId),
        eq(mailClassification.gmailMessageId, mailLink.gmailMessageId),
      ),
    )
    .leftJoin(
      mailLinkDecision,
      and(
        eq(mailLinkDecision.candidateId, mailLink.candidateId),
        eq(mailLinkDecision.gmailMessageId, mailLink.gmailMessageId),
      ),
    )
    .where(
      and(
        eq(mailLink.candidateId, candidateId),
        isNull(mailClassification.id),
        // A message Paul dismissed has left the Inbox: nothing more is done with it.
        sql`${mailLinkDecision.decision} is distinct from 'dismissed'`,
      ),
    )
    .orderBy(desc(mailLink.receivedAt), desc(mailLink.gmailMessageId))
    .limit(limit);
}

// Messages classified as recruiter mail that have no grade yet (REC-001: graded once the route is
// on), not counting ones Paul dismissed.
export async function countUngradedRecruiterMail(
  db: Pick<Db, "select">,
  candidateId: CandidateId,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(mailClassification)
    .leftJoin(
      recruiterGrade,
      and(
        eq(recruiterGrade.candidateId, mailClassification.candidateId),
        eq(recruiterGrade.gmailMessageId, mailClassification.gmailMessageId),
      ),
    )
    .leftJoin(
      mailLinkDecision,
      and(
        eq(mailLinkDecision.candidateId, mailClassification.candidateId),
        eq(mailLinkDecision.gmailMessageId, mailClassification.gmailMessageId),
      ),
    )
    .where(
      and(
        eq(mailClassification.candidateId, candidateId),
        eq(mailClassification.kind, "recruiter_inbound"),
        isNull(recruiterGrade.id),
        sql`${mailLinkDecision.decision} is distinct from 'dismissed'`,
      ),
    );
  return row?.n ?? 0;
}
