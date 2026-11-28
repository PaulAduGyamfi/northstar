import type { CandidateId } from "@northstar/domain";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { applicationPackage } from "./application-package-schema.js";
import type { Db } from "./db.js";
import { readPackageRounds } from "./package-read.js";
import { application } from "./schema.js";

// Where one application stands for the job pipeline workflow (NS-280 slice 2), read-only: its
// status, its job and, once a round was filed, the stored package of the newest round (its hash
// only, never the package). A run that crashed after filing finds its round's hash here and
// starts that round's submission instead of filing again.

export type PipelineState = {
  status: string;
  jobId: string;
  // The newest round's stored package (packageSha256), or null before any round was filed.
  packageSha256: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function readPipelineState(
  db: Db,
  candidateId: CandidateId,
  applicationId: string,
): Promise<PipelineState | null> {
  if (!UUID.test(applicationId)) return null;
  const [app] = await db
    .select({ status: application.status, jobId: application.jobId })
    .from(application)
    .where(and(eq(application.id, applicationId), eq(application.candidateId, candidateId)));
  if (!app) return null;
  // The newest round's package id comes from its own round-opening move (readPackageRounds); a
  // round that crashed before filing has no stored package yet.
  const { lastPackageId } = await readPackageRounds(db, candidateId, applicationId);
  if (lastPackageId === null) return { status: app.status, jobId: app.jobId, packageSha256: null };
  const [stored] = await db
    .select({ sha256: applicationPackage.contentSha256 })
    .from(applicationPackage)
    .where(
      and(
        eq(applicationPackage.candidateId, candidateId),
        eq(applicationPackage.applicationId, applicationId),
        sql`${applicationPackage.package} ->> 'packageId' = ${lastPackageId}`,
      ),
    )
    // An edited package (NS-203 slice 4) is stored again under the same package id: the newest
    // row is the one the Gate's live request pins.
    .orderBy(desc(applicationPackage.createdAt), desc(applicationPackage.id))
    .limit(1);
  return { status: app.status, jobId: app.jobId, packageSha256: stored?.sha256 ?? null };
}

// What the job pipeline's starter picks up each pass (NS-280 slice 3), read-only, ids and hashes
// only:
// - applications to prepare: `queued`, or `package_ready` (left by a run that opened a round and
//   stopped; preparePackage resumes it), freshest first (SRC-013), each with its round count
//   (readPackageRounds);
// - open rounds: an application at awaiting_approval whose newest stored package (an edit stores a
//   new one, NS-203 slice 4) has a request that is not withdrawn and either still waits for a
//   decision or was approved within the last OPEN_ROUND_APPROVED_HOURS by the Gate's clock. Its
//   submission run is started (once per hash), so an edited package's round runs. Never an older
//   approval: a round whose submission run already ended (gave up, failed) must not get a fresh
//   run once Temporal forgets the closed one (its dev server keeps closed runs about a day); a run
//   started within the hour is still known to Temporal, which refuses the duplicate start.
export type PipelineWork = {
  toPrepare: { applicationId: string; rounds: number }[];
  openRounds: { applicationId: string; packageSha256: string }[];
};

// At most this many of each a pass; the rest wait for the next pass.
export const PIPELINE_WORK_LIMIT = 50;
// How long after its approval took effect a round still counts as open (see above).
export const OPEN_ROUND_APPROVED_HOURS = 1;

export async function readPipelineWork(db: Db, candidateId: CandidateId): Promise<PipelineWork> {
  const prepareRows = await db
    .select({ id: application.id })
    .from(application)
    .where(
      and(
        eq(application.candidateId, candidateId),
        inArray(application.status, ["queued", "package_ready"]),
      ),
    )
    // Freshest first, so applications stuck waiting for Paul can't crowd out new ones.
    .orderBy(desc(application.createdAt), desc(application.id))
    .limit(PIPELINE_WORK_LIMIT);
  const toPrepare: PipelineWork["toPrepare"] = [];
  for (const row of prepareRows) {
    const { rounds } = await readPackageRounds(db, candidateId, row.id);
    toPrepare.push({ applicationId: row.id, rounds });
  }
  // The same cast as package-signal-read.ts: both drivers hand back `{ rows }`.
  const result = (await db.execute(sql`
    with newest as (
      select distinct on (p.application_id) p.application_id, p.content_sha256, p.request_id,
             p.candidate_id
      from application_package p
      join application a on a.id = p.application_id and a.candidate_id = p.candidate_id
      where p.candidate_id = ${candidateId} and a.status = 'awaiting_approval'
      order by p.application_id, p.created_at desc, p.id desc
    )
    select n.application_id, n.content_sha256
    from newest n
    where not exists (
        select 1 from approval_withdrawal w
        where w.request_id = n.request_id and w.candidate_id = n.candidate_id)
      -- No live decision yet, or a live approval that took effect within the hour; never a
      -- rejection, and never an older approval.
      and not exists (
        select 1 from approval_decision d
        where d.request_id = n.request_id and d.candidate_id = n.candidate_id
          and not exists (select 1 from approval_undo u where u.decision_id = d.id)
          and not (
            d.decision = 'approved'
            and d.effective_at > northstar_gate_now()
              - make_interval(hours => ${OPEN_ROUND_APPROVED_HOURS})
          ))
    order by n.application_id
    limit ${PIPELINE_WORK_LIMIT}
  `)) as unknown as { rows: { application_id: string; content_sha256: string }[] };
  return {
    toPrepare,
    openRounds: result.rows.map((r) => ({
      applicationId: r.application_id,
      packageSha256: r.content_sha256,
    })),
  };
}
