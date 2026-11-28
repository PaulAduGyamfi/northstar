import type { CandidateId } from "@northstar/domain";
import { and, desc, eq, sql } from "drizzle-orm";
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
// - queued applications, oldest first, each with its round count (readPackageRounds), so a round
//   after Paul rejected a package gets its own pipeline run;
// - open rounds: an application at awaiting_approval whose newest stored package (an edit stores
//   a new one, NS-203 slice 4) has a request that is not withdrawn and not rejected by a live
//   decision. Its submission run is started (once per hash), so an edited package's round runs.
export type PipelineWork = {
  queued: { applicationId: string; rounds: number }[];
  openRounds: { applicationId: string; packageSha256: string }[];
};

// At most this many of each a pass; the rest wait for the next pass.
export const PIPELINE_WORK_LIMIT = 50;

export async function readPipelineWork(db: Db, candidateId: CandidateId): Promise<PipelineWork> {
  const queuedRows = await db
    .select({ id: application.id })
    .from(application)
    .where(and(eq(application.candidateId, candidateId), eq(application.status, "queued")))
    .orderBy(application.createdAt, application.id)
    .limit(PIPELINE_WORK_LIMIT);
  const queued: PipelineWork["queued"] = [];
  for (const row of queuedRows) {
    const { rounds } = await readPackageRounds(db, candidateId, row.id);
    queued.push({ applicationId: row.id, rounds });
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
      and not exists (
        select 1 from approval_decision d
        where d.request_id = n.request_id and d.candidate_id = n.candidate_id
          and d.decision = 'rejected'
          and not exists (select 1 from approval_undo u where u.decision_id = d.id))
    order by n.application_id
    limit ${PIPELINE_WORK_LIMIT}
  `)) as unknown as { rows: { application_id: string; content_sha256: string }[] };
  return {
    queued,
    openRounds: result.rows.map((r) => ({
      applicationId: r.application_id,
      packageSha256: r.content_sha256,
    })),
  };
}
