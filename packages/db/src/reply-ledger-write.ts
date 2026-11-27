import type { CandidateId } from "@northstar/domain";
import { and, desc, eq, sql } from "drizzle-orm";
import { gateNow } from "./apply-write.js";
import type { Db } from "./db.js";
import { replyDraftClaim, replyDraftRecord } from "./reply-ledger-schema.js";
import { appendEvent, inSpan } from "./resilience-event.js";

// The Gmail draft writer's ledger (NS-237 slice 6, ADR-0025 item 5): the database side of
// writeReplyDraft's claimDraft / recordDraft ports in @northstar/gateways. One approval, one draft
// (RES-006): a claim is taken before the Gmail call and the draft's id is recorded after it.

// How long a claim counts as a live run. Longer than the drafts client's 30 s request timeout
// times the requests one run can make (a thread read, a message read, the create), with room to
// spare; a crashed run's claim lapses after it and the next run looks for its draft first.
export const DRAFT_CLAIM_LEASE_MS = 5 * 60_000;

// The claim's answer, shared with the gateway's MailPorts (packages/gateways imports this type).
export type DraftClaim =
  | { state: "new" }
  | { state: "done"; draftMessageId: string }
  | { state: "in_progress"; retryAt: Date }
  | { state: "unknown" };

// The schema's attempt bound: a claim past it is refused by name, never as a raw CHECK error.
export const MAX_DRAFT_CLAIMS = 100;

// The gateway's own id rule (drafts.ts GMAIL_ID): a draft it created must always be recordable, or a
// lapsed claim would retry it forever. Anything else is refused before the table's CHECK.
const DRAFT_ID = /^[A-Za-z0-9_-]{1,64}$/;

// A decision whose runs have lapsed MAX_DRAFT_CLAIMS times (hours of crashes): the caller stops
// and hands it to Paul (a dead letter) instead of trying forever.
export class DraftClaimsExhausted extends Error {
  constructor() {
    super("too many lapsed claims on this decision");
    this.name = "DraftClaimsExhausted";
  }
}

export class DraftRecordConflict extends Error {
  constructor() {
    super("a different draft is already recorded for this decision");
    this.name = "DraftRecordConflict";
  }
}

// Claims the decision for one run. `new` and `unknown` both take a claim (a new attempt row), so a
// run started meanwhile sees `in_progress`; `unknown` also tells the writer to look for a draft an
// earlier run may have made before it crashed.
export async function claimDraft(
  db: Db,
  candidateId: CandidateId,
  decisionId: string,
): Promise<DraftClaim> {
  return inSpan("db.reply_draft.claim", {}, (span) =>
    db.transaction(async (tx) => {
      // One run at a time per decision decides, so two racing runs can't both take attempt 1.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`reply_draft:${candidateId}:${decisionId}`}))`,
      );
      const [record] = await tx
        .select({ draftMessageId: replyDraftRecord.draftMessageId })
        .from(replyDraftRecord)
        .where(
          and(
            eq(replyDraftRecord.candidateId, candidateId),
            eq(replyDraftRecord.decisionId, decisionId),
          ),
        );
      if (record) {
        span.setAttribute("northstar.reply_draft.claim", "done");
        return { state: "done" as const, draftMessageId: record.draftMessageId };
      }
      const [latest] = await tx
        .select({ attempt: replyDraftClaim.attempt, claimedAt: replyDraftClaim.claimedAt })
        .from(replyDraftClaim)
        .where(
          and(
            eq(replyDraftClaim.candidateId, candidateId),
            eq(replyDraftClaim.decisionId, decisionId),
          ),
        )
        .orderBy(desc(replyDraftClaim.attempt))
        .limit(1);
      // The database's clock, as apply-write's live claim uses: workers on hosts whose clocks
      // disagree must still agree on whether a claim's lease has lapsed.
      const at = await gateNow(tx);
      if (latest) {
        const leaseEnd = new Date(latest.claimedAt.getTime() + DRAFT_CLAIM_LEASE_MS);
        if (at < leaseEnd) {
          span.setAttribute("northstar.reply_draft.claim", "in_progress");
          return { state: "in_progress" as const, retryAt: leaseEnd };
        }
      }
      if ((latest?.attempt ?? 0) >= MAX_DRAFT_CLAIMS) throw new DraftClaimsExhausted();
      await tx.insert(replyDraftClaim).values({
        candidateId,
        decisionId,
        attempt: (latest?.attempt ?? 0) + 1,
        claimedAt: at,
      });
      const state = latest ? ("unknown" as const) : ("new" as const);
      span.setAttribute("northstar.reply_draft.claim", state);
      return { state };
    }),
  );
}

// Records the draft a run created (or found), with its `reply.draft_created` event, once per
// decision. Recording the same id again stores nothing; a different id is refused, because one
// approval may only ever make one draft.
export async function recordDraft(
  db: Db,
  candidateId: CandidateId,
  decisionId: string,
  draftMessageId: string,
): Promise<void> {
  if (!DRAFT_ID.test(draftMessageId)) throw new Error("invalid draft message id");
  await inSpan("db.reply_draft.record", {}, (span) =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .insert(replyDraftRecord)
        .values({ candidateId, decisionId, draftMessageId, recordedAt: await gateNow(tx) })
        .onConflictDoNothing({
          target: [replyDraftRecord.candidateId, replyDraftRecord.decisionId],
        })
        .returning({ id: replyDraftRecord.id, recordedAt: replyDraftRecord.recordedAt });
      if (!row) {
        const [existing] = await tx
          .select({ draftMessageId: replyDraftRecord.draftMessageId })
          .from(replyDraftRecord)
          .where(
            and(
              eq(replyDraftRecord.candidateId, candidateId),
              eq(replyDraftRecord.decisionId, decisionId),
            ),
          );
        if (existing?.draftMessageId !== draftMessageId) throw new DraftRecordConflict();
        span.setAttribute("northstar.reply_draft.record", "already");
        return;
      }
      span.setAttribute("northstar.reply_draft.record", "recorded");
      await appendEvent(tx, span, {
        candidateId,
        aggregate: `reply_draft_record:${row.id}`,
        type: "reply.draft_created",
        actor: "system",
        // The feed shows this reason (no template): fixed words only.
        reason: "Wrote your approved reply as a Gmail draft for you to send",
        payload: { decisionId, draftMessageId },
        idempotencyKey: `reply_draft:${candidateId}:${decisionId}:recorded`,
        at: row.recordedAt,
      });
    }),
  );
}

// Binds the ledger to writeReplyDraft's ports (MailPorts.claimDraft / recordDraft).
export function dbMailLedger(db: Db) {
  return {
    claimDraft: (candidateId: CandidateId, decisionId: string) =>
      claimDraft(db, candidateId, decisionId),
    recordDraft: (candidateId: CandidateId, decisionId: string, draftMessageId: string) =>
      recordDraft(db, candidateId, decisionId, draftMessageId),
  };
}
