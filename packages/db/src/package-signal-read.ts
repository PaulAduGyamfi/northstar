import type { CandidateId } from "@northstar/domain";
import { sql } from "drizzle-orm";
import type { Db } from "./db.js";

// The Gate's settled outcomes for application packages, for the worker's signal relay (NS-213
// slice 2, #195 item 2): each package round's submission workflow waits for `approval` or
// `withdrawn`. Read-only, ids and hashes only (never the package).
//
// Only outcomes that have taken effect, by the Gate's own clock (northstar_gate_now(), the one
// that stamps effective_at): a run keeps the first decision it gets, so an approval relayed inside
// its undo window and then undone would end the round as not_approved, and that round's workflow
// id could never run again.

// How far back a settled outcome is relayed again. Re-reading is what makes a missed pass (or a
// worker that was down) harmless, without a cursor.
export const RELAY_WINDOW_DAYS = 7;
// At most this many rounds a pass, newest first.
export const RELAY_LIMIT = 200;

export type PackageSignal =
  | { kind: "approval"; applicationId: string; packageSha256: string; decisionId: string }
  // Withdrawn, or Paul's rejection took effect: the round's run ends instead of waiting.
  | { kind: "withdrawn"; applicationId: string; packageSha256: string };

type Row = {
  application_id: string;
  content_sha256: string;
  decision_id: string | null;
  decision: string | null;
  withdrawn: boolean;
};

export async function readPackageSignals(
  db: Db,
  candidateId: CandidateId,
): Promise<PackageSignal[]> {
  const result = (await db.execute(sql`
    select p.application_id, p.content_sha256, d.id as decision_id, d.decision,
           w.withdrawn_at is not null as withdrawn
    from application_package p
    join approval_request r
      on r.id = p.request_id and r.candidate_id = p.candidate_id
     and r.kind = 'application_package'
    -- The live decision that has taken effect: not undone, past its undo window.
    left join lateral (
      select d.id, d.decision, d.effective_at
      from approval_decision d
      where d.request_id = r.id and d.candidate_id = r.candidate_id
        and d.effective_at <= northstar_gate_now()
        and not exists (select 1 from approval_undo u where u.decision_id = d.id)
      order by d.effective_at desc
      limit 1
    ) d on true
    left join lateral (
      select min(w.withdrawn_at) as withdrawn_at
      from approval_withdrawal w
      where w.request_id = r.id and w.candidate_id = r.candidate_id
    ) w on true
    where p.candidate_id = ${candidateId}
      and greatest(w.withdrawn_at, d.effective_at)
          > northstar_gate_now() - make_interval(days => ${RELAY_WINDOW_DAYS})
    order by greatest(w.withdrawn_at, d.effective_at) desc, p.request_id
    limit ${RELAY_LIMIT}
  `)) as unknown as { rows: Row[] };
  return result.rows.map((row): PackageSignal => {
    const round = { applicationId: row.application_id, packageSha256: row.content_sha256 };
    // Withdrawn first: a closed request is never relayed as approved.
    if (row.withdrawn === true || row.decision === "rejected")
      return { kind: "withdrawn", ...round };
    if (row.decision === "approved" && row.decision_id !== null) {
      return { kind: "approval", ...round, decisionId: row.decision_id };
    }
    throw new Error(`unexpected approval decision: ${String(row.decision)}`);
  });
}
