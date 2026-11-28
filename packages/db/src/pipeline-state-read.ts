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
