import { createHash } from "node:crypto";
import type { CandidateId } from "@northstar/domain";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "./db.js";
import { type JobFormQuestion, jobForm } from "./job-form-schema.js";
import { appendEvent, inSpan } from "./resilience-event.js";
import { job, jobSource } from "./schema.js";

// A job's application form (NS-227, APPLY-001): the only writer of job_form. The questions are
// the employer's text, so the event carries the job id, the ATS and a count only.

// Bounds on what an ATS may hand us, checked before any insert: a real form is a few dozen fields.
const MAX_FIELDS = 200;
const MAX_TEXT_CHARS = 1000;
const MAX_CHOICES = 500;

export type SaveJobFormResult =
  | { status: "stored" | "unchanged"; questions: number }
  | { status: "refused"; reason: "too_many_fields" | "text_too_long" | "too_many_choices" };

// The questions with their keys in one fixed order, so the same form always hashes the same.
const canonical = (questions: readonly JobFormQuestion[]): JobFormQuestion[] =>
  questions.map((q) => ({
    fieldName: q.fieldName,
    label: q.label,
    required: q.required,
    kind: q.kind,
    choices: q.choices === null ? null : q.choices.map((c) => ({ label: c.label, value: c.value })),
    group: q.group,
  }));

function refusal(questions: readonly JobFormQuestion[]): SaveJobFormResult | null {
  if (questions.length > MAX_FIELDS) return { status: "refused", reason: "too_many_fields" };
  // Every piece of the employer's text: labels, field names, and each choice's label and value.
  const texts = questions.flatMap((q) => [
    q.label,
    q.fieldName,
    ...(q.choices ?? []).flatMap((c) => [c.label, c.value]),
  ]);
  if (texts.some((t) => t.length > MAX_TEXT_CHARS)) {
    return { status: "refused", reason: "text_too_long" };
  }
  if (questions.some((q) => (q.choices?.length ?? 0) > MAX_CHOICES)) {
    return { status: "refused", reason: "too_many_choices" };
  }
  return null;
}

// Stores the job's form when it differs from the job's current (newest) one; the same form as the
// current one stores nothing.
export async function saveJobForm(
  db: Db,
  input: {
    candidateId: CandidateId;
    jobId: string;
    ats: string;
    questions: readonly JobFormQuestion[];
    // Who asked: Paul's `jobs form` (user) or a pipeline step (system).
    actor?: "user" | "system";
  },
): Promise<SaveJobFormResult> {
  const refused = refusal(input.questions);
  if (refused) return refused;
  const questions = canonical(input.questions);
  const sha256 = createHash("sha256").update(JSON.stringify(questions)).digest("hex");
  return inSpan(
    "db.job.form_save",
    { "northstar.job.id": input.jobId, "northstar.form.questions": questions.length },
    (span) =>
      db.transaction(async (tx): Promise<SaveJobFormResult> => {
        // One read at a time per job, so two racing reads can't both store the same new form.
        await tx
          .select({ id: job.id })
          .from(job)
          .where(and(eq(job.id, input.jobId), eq(job.candidateId, input.candidateId)))
          .for("update");
        // Compared with the job's newest form only: a form that comes back after a change is
        // stored again and becomes current.
        const [newest] = await tx
          .select({ sha256: jobForm.sha256 })
          .from(jobForm)
          .where(and(eq(jobForm.candidateId, input.candidateId), eq(jobForm.jobId, input.jobId)))
          .orderBy(desc(jobForm.position))
          .limit(1);
        if (newest?.sha256 === sha256) return { status: "unchanged", questions: questions.length };
        const [row] = await tx
          .insert(jobForm)
          .values({
            candidateId: input.candidateId,
            jobId: input.jobId,
            ats: input.ats,
            sha256,
            questions,
          })
          .returning({ id: jobForm.id, readAt: jobForm.readAt });
        if (!row) throw new Error("job_form insert returned no row");
        await appendEvent(tx, span, {
          candidateId: input.candidateId,
          aggregate: `job:${input.jobId}`,
          type: "job.form_read",
          actor: input.actor ?? "system",
          // Fixed words and a count only: no label, company or URL.
          reason: `Read a job's application form: ${questions.length} field${questions.length === 1 ? "" : "s"}`,
          payload: { jobId: input.jobId, ats: input.ats, questions: questions.length },
          idempotencyKey: `job_form:${row.id}`,
          at: row.readAt,
        });
        return { status: "stored", questions: questions.length };
      }),
  );
}

// The job's newest stored form, or null before one is read.
export async function readJobForm(
  db: Pick<Db, "select">,
  candidateId: CandidateId,
  jobId: string,
): Promise<{ ats: string; questions: JobFormQuestion[]; readAt: Date } | null> {
  const [row] = await db
    .select({ ats: jobForm.ats, questions: jobForm.questions, readAt: jobForm.readAt })
    .from(jobForm)
    .where(and(eq(jobForm.candidateId, candidateId), eq(jobForm.jobId, jobId)))
    .orderBy(desc(jobForm.position))
    .limit(1);
  return row ?? null;
}

// A job's sources (its ATS and link), oldest first, so a caller can find the one whose
// API publishes the form.
export async function readJobAtsSources(
  db: Pick<Db, "select">,
  candidateId: CandidateId,
  jobId: string,
): Promise<{ ats: string | null; url: string }[]> {
  return db
    .select({ ats: jobSource.ats, url: jobSource.url })
    .from(jobSource)
    .where(and(eq(jobSource.candidateId, candidateId), eq(jobSource.jobId, jobId)))
    .orderBy(jobSource.fetchedAt, jobSource.id);
}
