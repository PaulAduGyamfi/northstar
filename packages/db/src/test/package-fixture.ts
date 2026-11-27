import { randomUUID } from "node:crypto";
import { type CandidateId, packageSha256, packageSubject, parsePackage } from "@northstar/domain";
import { applySubmission } from "../apply-schema.js";
import { decideApprovals, requestApproval } from "../approval-write.js";
import { setContact } from "../contact-write.js";
import type { Db } from "../db.js";
import { searchPreference } from "../fit-schema.js";
import { PREFERENCE_DEFAULTS, saveFitScore, savePreferences } from "../fit-write.js";
import { type JobFormQuestion, jobForm } from "../job-form-schema.js";
import { saveJobForm } from "../job-form-write.js";
import { requestPackageApproval } from "../package-approval.js";
import { readPackageInputs } from "../package-read.js";
import { profileSource } from "../profile-schema.js";
import { writeProfileImport } from "../profile-write.js";
import { application, company, job, jobSource } from "../schema.js";
import { saveTailoredResume } from "../tailor-write.js";

// A real application package filed through requestPackageApproval (NS-249): since requestApproval
// refuses caller facts, tests of the Gate's policies file packages whose facts the Gate derives
// itself. The fixture stores everything a strong-fit rule needs: the job's Greenhouse posting,
// contact details, a tailored resume PDF, the form, a fit score, and the same form sent before on
// another job (APPLY-003). The package fills no fields, so every answer counts as reused.
// Synthetic data only.
//
// Setting up writes its own rows and events (an approved `email_reply` decision backs the earlier
// submission): tests that count events or decisions take them after setup.

const CONTACT = { firstName: "Test", lastName: "Person", email: "test@example.com", phone: null };
const POSTING_ID = "4012345";
const APPLY_URL = `https://boards.greenhouse.io/example/jobs/${POSTING_ID}`;
// One optional question: the package leaves it blank.
const FORM: JobFormQuestion[] = [
  {
    fieldName: "question_1",
    label: "Anything else?",
    required: false,
    kind: "textarea",
    choices: null,
    group: 0,
  },
];

// Two contents for the same round: `b` differs only in the resume's file name, so both match the
// same rules and hash differently.
export type PackageVariant = "a" | "b";

export type FileOptions = {
  packageId?: string;
  variant?: PackageVariant;
  idempotencyKey?: string;
  actor?: string;
  // The package's filled fields (NS-203 slice 4); none by default.
  fields?: Record<string, string>;
};

export type PackageFixture = {
  applicationId: string;
  // The subject and content hash a package with these options is filed under.
  subjectOf: (packageId: string) => string;
  hashOf: (packageId: string, variant?: PackageVariant) => string;
  file: (options?: FileOptions) => ReturnType<typeof requestPackageApproval>;
};

export async function packageFixture(
  db: Db,
  candidateId: CandidateId,
  options: { fit?: number; now?: Date } = {},
): Promise<PackageFixture> {
  const now = options.now ?? new Date();
  const [co] = await db.insert(company).values({ candidateId, name: "Example Corp" }).returning();
  if (!co) throw new Error("fixture: no company");
  const newJob = async (title: string) => {
    const [j] = await db
      .insert(job)
      .values({
        candidateId,
        companyId: co.id,
        title,
        url: "https://jobs.example.com/role",
        status: "ready",
      })
      .returning({ id: job.id });
    if (!j) throw new Error("fixture: no job");
    return j.id;
  };
  const jobId = await newJob("Backend Engineer");
  // Rows straight in, as seedApplication does: the Gate reads only the row and its job, and
  // createApplication's event would add to what the tests count.
  const [app] = await db
    .insert(application)
    .values({ candidateId, jobId, status: "awaiting_approval" })
    .returning({ id: application.id });
  if (!app) throw new Error("fixture: no application");
  const applicationId = app.id;

  await db.insert(jobSource).values({
    candidateId,
    jobId,
    url: APPLY_URL,
    method: "ats_api",
    ats: "greenhouse",
    atsPostingId: POSTING_ID,
  });
  await setContact(db, { candidateId, contact: CONTACT });
  await writeProfileImport(db, {
    candidateId,
    fileName: "resume.txt",
    textSha256: "e".repeat(64),
    promptVersion: 1,
    model: "claude-opus-5-5",
    traceId: null,
    call: {},
    extract: { roles: [], education: [], atoms: [], skills: [], certifications: [], links: [] },
  });
  const [source] = await db.select({ id: profileSource.id }).from(profileSource);
  const sourceId = source?.id ?? "";
  await saveTailoredResume(db, {
    candidateId,
    jobId,
    profileSourceId: sourceId,
    resume: {},
    validation: {},
    score: {},
    droppedSkills: [],
    summary: {
      lines: 0,
      atoms: 0,
      addedSkills: 0,
      droppedSkills: 0,
      notClaimed: 0,
      keywordsCovered: 0,
      keywordsTotal: 0,
      titleMatch: "none",
      atsPass: true,
      valid: true,
      failures: 0,
    },
    pdf: new TextEncoder().encode("%PDF-1.7 synthetic"),
  });
  await saveJobForm(db, { candidateId, jobId, ats: "greenhouse", questions: FORM });

  // The fit score the Gate reads.
  await savePreferences(db, { candidateId, values: PREFERENCE_DEFAULTS, now });
  const [pref] = await db.select({ id: searchPreference.id }).from(searchPreference);
  await saveFitScore(db, {
    candidateId,
    now,
    jobId,
    preferenceId: pref?.id ?? "",
    preferenceVersion: 1,
    profileSourceId: sourceId,
    jobFingerprint: "f".repeat(64),
    score: options.fit ?? 92,
    band: "queue",
    reason: "ok",
    stretch: false,
    components: {},
    evidence: {},
  });

  const inputs = await readPackageInputs(db, candidateId, applicationId);
  const resumeSha = inputs?.resume?.pdfSha256 ?? "";
  const formSha = inputs?.form?.sha256 ?? "";

  // The same form went out through the Apply Gateway on another job, under an approved decision.
  const otherJob = await newJob("Other role");
  const [otherApp] = await db
    .insert(application)
    .values({ candidateId, jobId: otherJob, status: "submitted" })
    .returning({ id: application.id });
  await db.insert(jobForm).values({
    candidateId,
    jobId: otherJob,
    ats: "greenhouse",
    sha256: formSha,
    questions: FORM,
    readAt: new Date(now.getTime() - 3_600_000),
  });
  const earlier = await requestApproval(db, {
    candidateId,
    kind: "email_reply",
    subject: `email:${randomUUID()}`,
    contentSha256: "d".repeat(64),
    facts: null,
    actor: "agent:inbox",
    idempotencyKey: randomUUID(),
  });
  if (!earlier.ok) throw new Error(`fixture: ${earlier.error.kind}`);
  const decided = await decideApprovals(db, {
    candidateId,
    requestIds: [earlier.value.requestId],
    decision: "approve",
  });
  const decision = decided.ok ? decided.value[0]?.result : undefined;
  if (!decision?.ok) throw new Error("fixture: earlier decision refused");
  await db.insert(applySubmission).values({
    candidateId,
    applicationId: otherApp?.id ?? "",
    decisionId: decision.value.decisionId,
    ats: "greenhouse",
    requisitionKey: `greenhouse:${randomUUID()}`,
    idempotencyKey: `application:${otherApp?.id}:submit`,
    status: "submitted",
    reason: null,
    startedAt: new Date(now.getTime() - 60_000),
    finishedAt: now,
  });

  const pkg = (
    packageId: string,
    variant: PackageVariant = "a",
    fields: Record<string, string> = {},
  ) => ({
    packageId,
    applicationId,
    ats: "greenhouse",
    postingId: POSTING_ID,
    applyUrl: APPLY_URL,
    contact: CONTACT,
    resume: {
      fileName: variant === "a" ? "Test-Person-resume.pdf" : "Test-Person-resume-2.pdf",
      sha256: resumeSha,
    },
    coverLetter: null,
    fields,
  });
  const hashOf = (packageId: string, variant: PackageVariant = "a"): string => {
    const parsed = parsePackage(pkg(packageId, variant));
    if (!parsed.ok) throw new Error("fixture: package doesn't parse");
    return packageSha256(parsed.value);
  };
  return {
    applicationId,
    subjectOf: (packageId) => {
      const parsed = parsePackage(pkg(packageId));
      if (!parsed.ok) throw new Error("fixture: package doesn't parse");
      return packageSubject(parsed.value);
    },
    hashOf,
    file: (o = {}) =>
      requestPackageApproval(db, {
        candidateId,
        package: pkg(o.packageId ?? randomUUID(), o.variant, o.fields),
        claims: [],
        actor: o.actor ?? "agent:apply",
        idempotencyKey: o.idempotencyKey ?? randomUUID(),
      }),
  };
}
