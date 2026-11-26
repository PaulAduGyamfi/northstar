import type { CandidateId, ContactDetails } from "@northstar/domain";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { bankAnswer } from "./answer-schema.js";
import { type BankAnswerView, readBankAnswer } from "./answer-write.js";
import { readContact } from "./contact-write.js";
import type { Db } from "./db.js";
import { fitScore } from "./fit-schema.js";
import { type JobFormQuestion, jobForm } from "./job-form-schema.js";
import { application, company, job, jobSource } from "./schema.js";
import { type ProfileSettingView, readProfileSettings } from "./settings-write.js";
import { tailoredResume } from "./tailor-schema.js";

// Everything one application package is assembled from (NS-227 slice 5, APPLY-001), read in one
// place for the caller in packages/pipeline. Read-only. Every row is the candidate's own.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type PackageInputs = {
  application: { id: string; status: string; jobId: string };
  // For a banked answer's {company} slot; null when the job has no company.
  companyName: string | null;
  // The job's sources, oldest first: the caller picks the one its ATS adapter can open.
  sources: { ats: string | null; url: string; postingId: string | null }[];
  contact: ContactDetails | null;
  // The newest tailored version; its PDF is null on versions made before NS-227 slice 2.
  resume: { version: number; pdfSha256: string | null } | null;
  settings: ProfileSettingView[];
  // The newest approved answer per canonical question.
  bank: BankAnswerView[];
  form: { ats: string; sha256: string; questions: JobFormQuestion[] } | null;
  fit: number | null;
  // APPLY-003: this form's exact shape went out through the Apply Gateway on another job (see
  // seenBefore). Only stored shapes and the ledger count, never a model's or the extension's say.
  formSeenBefore: boolean;
};

export async function readPackageInputs(
  db: Db,
  candidateId: CandidateId,
  applicationId: string,
): Promise<PackageInputs | null> {
  if (!UUID.test(applicationId)) return null;
  const [app] = await db
    .select({
      id: application.id,
      status: application.status,
      jobId: application.jobId,
      companyName: company.name,
    })
    .from(application)
    .innerJoin(job, and(eq(job.id, application.jobId), eq(job.candidateId, candidateId)))
    .leftJoin(company, and(eq(company.id, job.companyId), eq(company.candidateId, candidateId)))
    .where(and(eq(application.id, applicationId), eq(application.candidateId, candidateId)))
    .limit(1);
  if (!app) return null;
  const jobId = app.jobId;

  const sources = await db
    .select({ ats: jobSource.ats, url: jobSource.url, postingId: jobSource.atsPostingId })
    .from(jobSource)
    .where(and(eq(jobSource.candidateId, candidateId), eq(jobSource.jobId, jobId)))
    .orderBy(asc(jobSource.fetchedAt), asc(jobSource.id));

  const [resume] = await db
    .select({ version: tailoredResume.version, pdfSha256: tailoredResume.pdfSha256 })
    .from(tailoredResume)
    .where(and(eq(tailoredResume.candidateId, candidateId), eq(tailoredResume.jobId, jobId)))
    .orderBy(desc(tailoredResume.version))
    .limit(1);

  const [form] = await db
    .select({ ats: jobForm.ats, sha256: jobForm.sha256, questions: jobForm.questions })
    .from(jobForm)
    .where(and(eq(jobForm.candidateId, candidateId), eq(jobForm.jobId, jobId)))
    .orderBy(desc(jobForm.position))
    .limit(1);

  const [fit] = await db
    .select({ score: fitScore.score })
    .from(fitScore)
    .where(and(eq(fitScore.candidateId, candidateId), eq(fitScore.jobId, jobId)))
    // The same order as the pipeline's view (pipeline-read.ts), so both show one score.
    .orderBy(desc(fitScore.scoredAt), desc(fitScore.id))
    .limit(1);

  const canonicalIds = await db
    .selectDistinct({ canonicalId: bankAnswer.canonicalId })
    .from(bankAnswer)
    .where(eq(bankAnswer.candidateId, candidateId))
    .orderBy(asc(bankAnswer.canonicalId));
  const bank: BankAnswerView[] = [];
  for (const { canonicalId } of canonicalIds) {
    const answer = await readBankAnswer(db, candidateId, canonicalId);
    if (answer) bank.push(answer);
  }

  return {
    application: { id: app.id, status: app.status, jobId },
    companyName: app.companyName ?? null,
    sources,
    contact: await readContact(db, candidateId),
    resume: resume ?? null,
    settings: await readProfileSettings(db, candidateId),
    bank,
    form: form ?? null,
    fit: fit?.score ?? null,
    formSeenBefore: form ? await seenBefore(db, candidateId, jobId, form) : false,
  };
}

// APPLY-003: another job's application went out through the Apply Gateway (its ledger row
// finished `submitted`), and the form that job had when it went out (its newest form read before
// the submission finished) has this exact shape on the same ATS. Paul's own submissions (by hand,
// or "I submitted it" on a handoff) have no ledger row, so a form Northstar never filled is never
// "seen", and nor is a shape the other job only took on after it went out.
async function seenBefore(
  db: Db,
  candidateId: CandidateId,
  jobId: string,
  form: { ats: string; sha256: string },
): Promise<boolean> {
  // The same cast as apply-write.ts: both drivers hand back `{ rows }`.
  const result = (await db.execute(sql`
    select exists (
      select 1
      from apply_submission s
      join application a on a.id = s.application_id and a.candidate_id = ${candidateId}
      join job_form f on f.candidate_id = ${candidateId} and f.job_id = a.job_id
      where s.candidate_id = ${candidateId}
        and s.status = 'submitted'
        and a.job_id <> ${jobId}
        and f.ats = ${form.ats}
        and f.sha256 = ${form.sha256}
        and f.position = (
          select max(f2.position) from job_form f2
          where f2.candidate_id = ${candidateId} and f2.job_id = a.job_id
            and f2.read_at <= s.finished_at
        )
    ) as seen`)) as unknown as { rows: { seen: boolean }[] };
  return result.rows[0]?.seen === true;
}
