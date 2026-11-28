import type { CandidateId } from "@northstar/domain";
import { and, desc, eq, gte, inArray, isNull, notExists, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { mailClassification } from "./mail-classification-schema.js";
import { mailLinkDecision } from "./mail-link-decision-schema.js";
import { mailLink } from "./mail-link-schema.js";
import { recruiterGrade } from "./recruiter-grade-schema.js";
import { recruiterRegrade } from "./recruiter-regrade-schema.js";
import { replyDraft } from "./reply-schema.js";

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

// Which of the given messages the mail loop has recorded (a mail_link row), the candidate's own only.
export async function readRecordedMessageIds(
  db: Pick<Db, "select">,
  candidateId: CandidateId,
  gmailMessageIds: readonly string[],
): Promise<Set<string>> {
  if (gmailMessageIds.length === 0) return new Set();
  const rows = await db
    .select({ gmailMessageId: mailLink.gmailMessageId })
    .from(mailLink)
    .where(
      and(
        eq(mailLink.candidateId, candidateId),
        inArray(mailLink.gmailMessageId, [...gmailMessageIds]),
      ),
    );
  return new Set(rows.map((r) => r.gmailMessageId));
}

// Messages classified as recruiter mail with no grade and no dismissal, newest first, at most
// `limit` (NS-238 item 1 slice 2: what `funnel inbox` grades). Ids only.
export async function readUngradedRecruiterMail(
  db: Pick<Db, "select">,
  candidateId: CandidateId,
  limit: number,
): Promise<UnclassifiedMail[]> {
  return db
    .select({ mailLinkId: mailLink.id, gmailMessageId: mailLink.gmailMessageId })
    .from(mailClassification)
    .innerJoin(
      mailLink,
      and(
        eq(mailLink.candidateId, mailClassification.candidateId),
        eq(mailLink.gmailMessageId, mailClassification.gmailMessageId),
      ),
    )
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
    )
    .orderBy(desc(mailLink.receivedAt), desc(mailLink.gmailMessageId))
    .limit(limit);
}

// A graded recruiter email `funnel inbox` may file a reply for (NS-238 item 2's caller): its ids
// and the letter its reply follows, Paul's newest regrade when he gave one, else the grader's.
export type ReplyCandidate = {
  mailLinkId: string;
  gmailMessageId: string;
  threadId: string;
  grade: string;
};

// Graded recruiter mail received at or after `since` that has no reply draft filed for it (ever:
// one filing per message, even after Paul rejected or edited it), that Paul hasn't dismissed and
// whose letter isn't F (no reply for an F, REC-002), newest first, at most `limit`. Read-only.
export async function readReplyCandidates(
  db: Pick<Db, "select">,
  candidateId: CandidateId,
  input: { since: Date; limit: number },
): Promise<ReplyCandidate[]> {
  // Paul's letter wins: the newest regrade by its identity position, else the stored grade.
  const letter = sql<string>`coalesce((
    select ${recruiterRegrade.grade} from ${recruiterRegrade}
    where ${recruiterRegrade.candidateId} = ${recruiterGrade.candidateId}
      and ${recruiterRegrade.gmailMessageId} = ${recruiterGrade.gmailMessageId}
    order by ${recruiterRegrade.position} desc limit 1
  ), ${recruiterGrade.grade})`;
  const rows = await db
    .select({
      mailLinkId: mailLink.id,
      gmailMessageId: recruiterGrade.gmailMessageId,
      threadId: mailLink.gmailThreadId,
      grade: letter,
    })
    .from(recruiterGrade)
    .innerJoin(
      mailLink,
      and(
        eq(mailLink.candidateId, recruiterGrade.candidateId),
        eq(mailLink.gmailMessageId, recruiterGrade.gmailMessageId),
      ),
    )
    .leftJoin(
      mailLinkDecision,
      and(
        eq(mailLinkDecision.candidateId, recruiterGrade.candidateId),
        eq(mailLinkDecision.gmailMessageId, recruiterGrade.gmailMessageId),
      ),
    )
    .where(
      and(
        eq(recruiterGrade.candidateId, candidateId),
        gte(mailLink.receivedAt, input.since),
        sql`${mailLinkDecision.decision} is distinct from 'dismissed'`,
        sql`${letter} <> 'F'`,
        // Not a join: an edited reply leaves several drafts for one message.
        notExists(
          db
            .select({ one: sql`1` })
            .from(replyDraft)
            .where(
              and(
                eq(replyDraft.candidateId, recruiterGrade.candidateId),
                eq(replyDraft.gmailMessageId, recruiterGrade.gmailMessageId),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(mailLink.receivedAt), desc(mailLink.gmailMessageId))
    .limit(input.limit);
  return rows.map((r) => ({ ...r, grade: String(r.grade) }));
}
