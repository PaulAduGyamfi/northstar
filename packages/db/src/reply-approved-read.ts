import type { CandidateId } from "@northstar/domain";
import { sql } from "drizzle-orm";
import type { Db } from "./db.js";

// The reply drafts Paul approved that the Gmail draft writer hasn't written yet (NS-281 slice 1,
// RPL-002, ADR-0025), for `funnel drafts`. Read-only, ids only: never a recipient, subject or body.
//
// Only approvals that have taken effect by the Gate's own clock (northstar_gate_now()), not undone
// and not withdrawn: inside the undo window Paul can still take the approval back, and the writer
// would only be refused (`UndoWindowOpen`). A request needs its stored `reply_draft` (the writer
// reads it). A decision with a draft record is done; one with only a claim is listed again, so the
// ledger's lease decides whether a rerun may continue it. The same rule as readApprovedPrepPlans.

// At most this many replies a run, newest first.
export const APPROVED_REPLY_LIMIT = 50;

export type ApprovedReply = { requestId: string; decisionId: string };

type Row = { request_id: string; decision_id: string };

export async function readApprovedReplies(
  db: Db,
  candidateId: CandidateId,
): Promise<ApprovedReply[]> {
  const result = (await db.execute(sql`
    select rd.request_id, d.id as decision_id
    from reply_draft rd
    join approval_request r
      on r.id = rd.request_id and r.candidate_id = rd.candidate_id and r.kind = 'email_reply'
    -- The newest live decision that has taken effect: not undone, past its undo window.
    join lateral (
      select d.id, d.decision, d.effective_at
      from approval_decision d
      where d.request_id = r.id and d.candidate_id = r.candidate_id
        and d.effective_at <= northstar_gate_now()
        and not exists (select 1 from approval_undo u where u.decision_id = d.id)
      order by d.effective_at desc
      limit 1
    ) d on true
    where rd.candidate_id = ${candidateId}
      and d.decision = 'approved'
      -- A withdrawn request is closed (db.md): never written. An edited reply's old request is
      -- withdrawn by Paul, so only the edited one can be listed.
      and not exists (
        select 1 from approval_withdrawal w
        where w.request_id = r.id and w.candidate_id = r.candidate_id
      )
      -- Already written: one record per decision.
      and not exists (
        select 1 from reply_draft_record rr
        where rr.decision_id = d.id and rr.candidate_id = rd.candidate_id
      )
    order by d.effective_at desc, rd.request_id
    limit ${APPROVED_REPLY_LIMIT}
  `)) as unknown as { rows: Row[] };
  return result.rows.map((row) => ({ requestId: row.request_id, decisionId: row.decision_id }));
}
