import { randomUUID } from "node:crypto";
import { type CandidateId, err, ok, type Result } from "@northstar/domain";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { type ATS_KINDS, company, domainEvent, job, jobSource } from "./schema.js";

// The job write path (NS-114, SRC-001/006/009). packages/sources decides what a posting says and
// which job it duplicates; this module only stores it, in one transaction per posting.

export type Ats = (typeof ATS_KINDS)[number];
export type SourceMethod = "ats_api" | "jsonld" | "model" | "text";

// A posting's normalized fields. null means "not found", never a guess.
export type JobFields = {
  title: string | null;
  company: string | null;
  location: string | null;
  remote: "onsite" | "hybrid" | "remote" | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: "year" | "month" | "hour" | null;
  seniority: string | null;
  requirements: string[];
  niceToHaves: string[];
  applyUrl: string | null;
  ats: Ats | null;
  description: string | null;
  postedAt: Date | null;
};

export type JobSourceInput = {
  // Canonical: tracking parameters already removed by packages/sources.
  url: string;
  method: SourceMethod;
  ats: Ats | null;
  atsPostingId: string | null;
};

export type SaveResult = { status: "created" | "merged" | "unchanged"; jobId: string };

// The fields SRC-001 lists, counted for the event (currency and period are part of the salary).
const COUNTED: (keyof JobFields)[] = [
  "title",
  "company",
  "location",
  "remote",
  "salaryMin",
  "salaryMax",
  "seniority",
  "requirements",
  "niceToHaves",
  "applyUrl",
  "ats",
  "description",
  "postedAt",
];
const found = (f: JobFields) =>
  COUNTED.filter((k) => {
    const v = f[k];
    return Array.isArray(v) ? v.length > 0 : v !== null;
  }).length;

// Title and company decide whether a job is ready; without them it's a draft Paul completes.
const missingOf = (f: { title: string | null; company: string | null }) =>
  [f.title ? null : "title", f.company ? null : "company"].filter((x): x is string => x !== null);

// Stores one posting. A source already stored (same URL, or the same ATS posting) changes nothing.
// `mergeInto` names an existing job this posting duplicates (SRC-006): the source joins that job
// and its fields are left as they are. Otherwise a new job is created, ready or a draft.
export async function saveIngestedJob(
  db: Db,
  input: {
    candidateId: CandidateId;
    fields: JobFields;
    source: JobSourceInput;
    mergeInto: string | null;
    // The model call that read the posting (ids, versions and numbers only, OBV-003), or null
    // when plain code read it.
    call?: Record<string, string | number | boolean | null> | null;
  },
): Promise<SaveResult> {
  const { candidateId, fields, source } = input;
  return db.transaction(async (tx) => {
    const sameSource = or(
      eq(jobSource.url, source.url),
      source.atsPostingId && source.ats
        ? and(eq(jobSource.ats, source.ats), eq(jobSource.atsPostingId, source.atsPostingId))
        : sql`false`,
    );
    const [existing] = await tx
      .select({ jobId: jobSource.jobId })
      .from(jobSource)
      .where(and(eq(jobSource.candidateId, candidateId), sameSource));
    if (existing) return { status: "unchanged", jobId: existing.jobId } as const;

    if (input.mergeInto) {
      await tx.insert(jobSource).values({ candidateId, jobId: input.mergeInto, ...source });
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(jobSource)
        .where(eq(jobSource.jobId, input.mergeInto));
      await insertEvent(tx, candidateId, input.mergeInto, "job.merged", "Same role seen again", {
        method: source.method,
        sources: n,
      });
      return { status: "merged", jobId: input.mergeInto } as const;
    }

    const companyId = fields.company ? await companyIdFor(tx, candidateId, fields.company) : null;
    const missing = missingOf(fields);
    const { company: _company, ...columns } = fields;
    const [row] = await tx
      .insert(job)
      .values({
        candidateId,
        companyId,
        url: source.url,
        status: missing.length === 0 ? "ready" : "draft",
        missingFields: missing,
        ...columns,
      })
      .returning({ id: job.id });
    if (!row) throw new Error("job insert returned no row");
    await tx.insert(jobSource).values({ candidateId, jobId: row.id, ...source });
    await insertEvent(tx, candidateId, row.id, "job.ingested", "Job added from a link", {
      method: source.method,
      ats: source.ats,
      fieldsFound: found(fields),
      draft: missing.length > 0,
      ...(input.call ? { call: input.call } : {}),
    });
    return { status: "created", jobId: row.id } as const;
  });
}

// The company with this name (case and surrounding space ignored), created if new.
async function companyIdFor(
  tx: Pick<Db, "select" | "insert">,
  candidateId: CandidateId,
  name: string,
): Promise<string> {
  const clean = name.trim();
  const [hit] = await tx
    .select({ id: company.id })
    .from(company)
    .where(
      and(
        eq(company.candidateId, candidateId),
        sql`lower(trim(${company.name})) = lower(${clean})`,
      ),
    )
    .limit(1);
  if (hit) return hit.id;
  const [created] = await tx.insert(company).values({ candidateId, name: clean }).returning();
  if (!created) throw new Error("company insert returned no row");
  return created.id;
}

// The fields Paul may set by hand on a job (a draft's gaps, or a wrong value).
const EDITABLE = {
  title: "text",
  company: "text",
  location: "text",
  remote: "remote",
  salaryMin: "int",
  salaryMax: "int",
  seniority: "text",
  applyUrl: "url",
} as const;
type Editable = keyof typeof EDITABLE;

export type SetFieldError =
  | { kind: "NotEditable"; field: string }
  | { kind: "BadValue"; field: string }
  | { kind: "NotFound" };

// Paul's edit of one field. Completing a draft's last missing field makes the job ready.
export async function setJobField(
  db: Db,
  input: { candidateId: CandidateId; jobId: string; field: string; value: string },
): Promise<Result<{ status: "draft" | "ready"; missingFields: string[] }, SetFieldError>> {
  if (!(input.field in EDITABLE)) return err({ kind: "NotEditable", field: input.field });
  const field = input.field as Editable;
  const value = input.value.trim();
  const kind = EDITABLE[field];
  const bad = () => err({ kind: "BadValue", field } as const);
  if (value === "") return bad();
  let parsed: string | number = value;
  if (kind === "int") {
    if (!/^\d{1,9}$/.test(value)) return bad();
    parsed = Number(value);
  }
  if (kind === "remote" && !["onsite", "hybrid", "remote"].includes(value)) return bad();
  if (kind === "url" && !/^https?:\/\/\S+$/.test(value)) return bad();

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        status: job.status,
        title: job.title,
        companyId: job.companyId,
        salaryMin: job.salaryMin,
        salaryMax: job.salaryMax,
      })
      .from(job)
      .where(and(eq(job.id, input.jobId), eq(job.candidateId, input.candidateId)));
    if (!current) return err({ kind: "NotFound" } as const);
    // The database refuses min > max; say so plainly instead of failing on its check.
    const min = field === "salaryMin" ? (parsed as number) : current.salaryMin;
    const max = field === "salaryMax" ? (parsed as number) : current.salaryMax;
    if (min !== null && max !== null && min > max) return bad();
    const set: Partial<typeof job.$inferInsert> =
      field === "company"
        ? { companyId: await companyIdFor(tx, input.candidateId, value) }
        : { [field]: parsed };
    const title = field === "title" ? value : current.title;
    const hasCompany = field === "company" || current.companyId !== null;
    const missing = missingOf({ title, company: hasCompany ? "set" : null });
    const status = missing.length === 0 ? "ready" : "draft";
    await tx
      .update(job)
      .set({ ...set, status, missingFields: missing })
      .where(eq(job.id, input.jobId));
    if (current.status === "draft" && status === "ready") {
      await insertEvent(
        tx,
        input.candidateId,
        input.jobId,
        "job.draft_completed",
        "Draft completed by Paul",
        {
          field,
        },
      );
    }
    return ok({ status, missingFields: missing } as const);
  });
}

export type DedupeCandidate = {
  jobId: string;
  company: string | null;
  title: string | null;
  location: string | null;
  description: string | null;
  sources: { url: string; ats: Ats | null; atsPostingId: string | null }[];
};

// Every job with what dedupe compares (SRC-006). Single user, so a full read is fine for now.
export async function readDedupeCandidates(
  db: Db,
  candidateId: CandidateId,
): Promise<DedupeCandidate[]> {
  const rows = await db
    .select({
      jobId: job.id,
      company: company.name,
      title: job.title,
      location: job.location,
      description: job.description,
    })
    .from(job)
    .leftJoin(company, eq(company.id, job.companyId))
    .where(eq(job.candidateId, candidateId))
    .orderBy(job.firstSeenAt);
  const ids = rows.map((r) => r.jobId);
  const sources =
    ids.length === 0
      ? []
      : await db
          .select({
            jobId: jobSource.jobId,
            url: jobSource.url,
            ats: jobSource.ats,
            atsPostingId: jobSource.atsPostingId,
          })
          .from(jobSource)
          .where(inArray(jobSource.jobId, ids))
          .orderBy(jobSource.fetchedAt);
  return rows.map((r) => ({
    ...r,
    sources: sources
      .filter((s) => s.jobId === r.jobId)
      .map(({ url, ats, atsPostingId }) => ({ url, ats: ats as Ats | null, atsPostingId })),
  }));
}

export type JobListItem = {
  id: string;
  status: "draft" | "ready";
  title: string | null;
  company: string | null;
  location: string | null;
  postedAt: Date | null;
  firstSeenAt: Date;
  sources: number;
  missingFields: string[];
};

// Jobs newest first (SRC-009): by posting time when the source gave one, else first seen.
export async function listJobs(db: Db, candidateId: CandidateId): Promise<JobListItem[]> {
  const rows = await db
    .select({
      id: job.id,
      status: job.status,
      title: job.title,
      company: company.name,
      location: job.location,
      postedAt: job.postedAt,
      firstSeenAt: job.firstSeenAt,
      missingFields: job.missingFields,
      sources: sql<number>`(select count(*)::int from ${jobSource} where ${jobSource.jobId} = ${job.id})`,
    })
    .from(job)
    .leftJoin(company, eq(company.id, job.companyId))
    .where(eq(job.candidateId, candidateId))
    .orderBy(desc(sql`coalesce(${job.postedAt}, ${job.firstSeenAt})`));
  return rows.map((r) => ({ ...r, status: r.status as "draft" | "ready" }));
}

async function insertEvent(
  tx: Pick<Db, "insert">,
  candidateId: CandidateId,
  jobId: string,
  type: "job.ingested" | "job.merged" | "job.draft_completed",
  reason: string,
  // Counts, methods, field names and the call record only: never a title, company, URL or text.
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.insert(domainEvent).values({
    id: randomUUID(),
    candidateId,
    aggregate: `job:${jobId}`,
    type,
    actor: "user",
    reason,
    inputsSummary: "",
    payload,
    links: [],
    traceId: null,
    idempotencyKey: `${type}:${jobId}:${randomUUID()}`,
    occurredAt: new Date(),
  });
}
