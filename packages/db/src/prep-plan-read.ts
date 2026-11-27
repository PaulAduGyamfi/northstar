import type { CandidateId } from "@northstar/domain";
import { sql } from "drizzle-orm";
import type { Db } from "./db.js";

// The prep plans Paul approved that the Calendar writer hasn't written yet (NS-241 slice 5), for
// `funnel prep`. Read-only, ids only: never a block, time or zone.
//
// Only approvals that have taken effect by the Gate's own clock (northstar_gate_now()), not undone
// and not withdrawn: inside the undo window Paul can still take the approval back, and the writer
// would only be refused (`UndoWindowOpen`). A decision with a write record is done; one with only
// a claim is listed again, so the ledger's lease decides whether a rerun may continue it.

// At most this many plans a run, newest first.
export const APPROVED_PREP_LIMIT = 50;

export type ApprovedPrepPlan = { requestId: string; decisionId: string };

type Row = { request_id: string; decision_id: string };

export async function readApprovedPrepPlans(
  db: Db,
  candidateId: CandidateId,
): Promise<ApprovedPrepPlan[]> {
  const result = (await db.execute(sql`
    select p.request_id, d.id as decision_id
    from prep_plan_request p
    join approval_request r
      on r.id = p.request_id and r.candidate_id = p.candidate_id and r.kind = 'prep_plan'
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
    where p.candidate_id = ${candidateId}
      and d.decision = 'approved'
      -- A withdrawn request is closed (db.md): never written.
      and not exists (
        select 1 from approval_withdrawal w
        where w.request_id = r.id and w.candidate_id = r.candidate_id
      )
      -- Already written: one record per decision.
      and not exists (
        select 1 from prep_write_record pw
        where pw.decision_id = d.id and pw.candidate_id = p.candidate_id
      )
    order by d.effective_at desc, p.request_id
    limit ${APPROVED_PREP_LIMIT}
  `)) as unknown as { rows: Row[] };
  return result.rows.map((row) => ({ requestId: row.request_id, decisionId: row.decision_id }));
}
