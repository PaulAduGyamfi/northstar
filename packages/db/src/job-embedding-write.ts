import type { CandidateId } from "@northstar/domain";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import {
  jobDuplicateSuggestion,
  jobEmbedding,
  STORED_EMBED_DIMENSIONS,
  STORED_EMBED_MODEL,
} from "./job-embedding-schema.js";
import { readClosedJobIds } from "./liveness-write.js";
import { appendEvent, inSpan } from "./resilience-event.js";
import { company, job } from "./schema.js";

// The job-embedding write path (NS-129 slice 2, SRC-006, ADR-0033). packages/sources decides what
// text is embedded and which pairs are alike enough; this module stores vectors and suggestions
// and compares stored vectors. A suggestion never merges, edits or deletes a job.

const SHA256 = /^[0-9a-f]{64}$/;

export type EmbeddingRefusal =
  | { kind: "InvalidEmbedding"; field: "embedding" | "textSha256" }
  // Not one of the candidate's ready jobs: only a ready job is compared.
  | { kind: "JobNotReady" };

// Stores a job's vector for its current text. When the job's newest vector is already of this text
// it stores nothing ("unchanged"); any other text, including one the job held before, is a new row,
// so the newest row is always the job's text now. No domain event: one per embedded job would
// flood the feed, and the vector says nothing to Paul. The suggestion it may lead to is the event.
export async function saveJobEmbedding(
  db: Db,
  input: { candidateId: CandidateId; jobId: string; textSha256: string; embedding: number[] },
): Promise<
  { ok: true; value: { status: "stored" | "unchanged" } } | { ok: false; error: EmbeddingRefusal }
> {
  if (!SHA256.test(input.textSha256)) {
    return { ok: false, error: { kind: "InvalidEmbedding", field: "textSha256" } };
  }
  if (
    input.embedding.length !== STORED_EMBED_DIMENSIONS ||
    !input.embedding.every((n) => Number.isFinite(n)) ||
    // A zero vector has no direction: its cosine is NaN (the table's CHECK refuses it too).
    input.embedding.every((n) => n === 0)
  ) {
    return { ok: false, error: { kind: "InvalidEmbedding", field: "embedding" } };
  }
  return inSpan("job.embedding_save", { "northstar.embed.model": STORED_EMBED_MODEL }, (span) =>
    db.transaction(async (tx) => {
      // The job's row lock serializes two saves for one job, so the newest-hash check holds.
      const [ready] = await tx
        .select({ id: job.id })
        .from(job)
        .where(
          and(
            eq(job.id, input.jobId),
            eq(job.candidateId, input.candidateId),
            eq(job.status, "ready"),
          ),
        )
        .for("update");
      if (ready === undefined) return { ok: false, error: { kind: "JobNotReady" } } as const;
      const [newest] = await tx
        .select({ textSha256: jobEmbedding.textSha256 })
        .from(jobEmbedding)
        .where(
          and(
            eq(jobEmbedding.candidateId, input.candidateId),
            eq(jobEmbedding.jobId, input.jobId),
            eq(jobEmbedding.model, STORED_EMBED_MODEL),
          ),
        )
        .orderBy(desc(jobEmbedding.position))
        .limit(1);
      if (newest?.textSha256 === input.textSha256) {
        span.setAttribute("northstar.embed.status", "unchanged");
        return { ok: true, value: { status: "unchanged" } } as const;
      }
      await tx.insert(jobEmbedding).values({
        candidateId: input.candidateId,
        jobId: input.jobId,
        model: STORED_EMBED_MODEL,
        dimensions: STORED_EMBED_DIMENSIONS,
        textSha256: input.textSha256,
        embedding: input.embedding,
      });
      span.setAttribute("northstar.embed.status", "stored");
      return { ok: true, value: { status: "stored" } } as const;
    }),
  );
}

// The text SHA-256 of each given job's current (newest) vector, so a caller embeds only jobs whose
// text changed or that have none. Jobs with no vector are absent from the map.
export async function readEmbeddingHashes(
  db: Db,
  candidateId: CandidateId,
  jobIds: readonly string[],
): Promise<Map<string, string>> {
  if (jobIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([jobEmbedding.jobId], {
      jobId: jobEmbedding.jobId,
      textSha256: jobEmbedding.textSha256,
    })
    .from(jobEmbedding)
    .where(
      and(
        eq(jobEmbedding.candidateId, candidateId),
        eq(jobEmbedding.model, STORED_EMBED_MODEL),
        inArray(jobEmbedding.jobId, [...jobIds]),
      ),
    )
    .orderBy(jobEmbedding.jobId, desc(jobEmbedding.position));
  return new Map(rows.map((r) => [r.jobId, r.textSha256]));
}

export type SimilarJob = { jobId: string; similarity: number };

// The candidate's other ready, open jobs whose current vector is at least `minSimilarity` alike
// (cosine) to this job's current vector, most alike first. Empty when the job has no vector.
export async function findSimilarJobs(
  db: Db,
  input: { candidateId: CandidateId; jobId: string; minSimilarity: number; limit: number },
): Promise<SimilarJob[]> {
  if (!(input.minSimilarity >= 0 && input.minSimilarity <= 1)) {
    throw new RangeError("minSimilarity must be between 0 and 1");
  }
  // Callers ask for a handful (suggestDuplicates: 5); 50 bounds a mistaken caller's read.
  const limit = Math.max(1, Math.min(50, Math.floor(input.limit)));
  const closed = await readClosedJobIds(db, input.candidateId);
  // A closed job raises no suggestions either: only open jobs are compared, on both sides.
  if (closed.has(input.jobId)) return [];
  // Each ready job's newest vector; then this job's against every other one's.
  const result = (await db.execute(sql`
    with current_vector as (
      select distinct on (e.job_id) e.job_id, e.embedding
      from job_embedding e
      join job j on j.id = e.job_id and j.candidate_id = e.candidate_id
      where e.candidate_id = ${input.candidateId}
        and e.model = ${STORED_EMBED_MODEL}
        and j.status = 'ready'
      order by e.job_id, e.position desc
    )
    select other.job_id, 1 - (other.embedding <=> self.embedding) as similarity
    from current_vector self
    join current_vector other on other.job_id <> self.job_id
    where self.job_id = ${input.jobId}
      and 1 - (other.embedding <=> self.embedding) >= ${input.minSimilarity}
    order by similarity desc, other.job_id
    -- Closed jobs are dropped below, so read enough rows to fill the limit after dropping them.
    limit ${limit + closed.size}
  `)) as unknown as { rows: { job_id: string; similarity: number | string }[] };
  return result.rows
    .filter((r) => !closed.has(r.job_id))
    .slice(0, limit)
    .map((r) => ({ jobId: r.job_id, similarity: Number(r.similarity) }));
}

// The feed line: fixed words, never a title, company or similarity.
export const DUPLICATE_SUGGESTED_REASON = "Two saved jobs look like the same role: check them";

// Stores one suggestion for a pair of the candidate's jobs, with a `job.duplicate_suggested`
// event. The pair is stored in one order, so suggesting it again (either way round) stores nothing.
export async function recordDuplicateSuggestion(
  db: Db,
  input: { candidateId: CandidateId; jobIds: [string, string]; similarity: number },
): Promise<{ status: "stored" | "exists" }> {
  const [jobA, jobB] = [...input.jobIds].sort() as [string, string];
  if (jobA === jobB) throw new RangeError("a job can't duplicate itself");
  if (!(input.similarity >= 0 && input.similarity <= 1)) {
    throw new RangeError("similarity must be between 0 and 1");
  }
  try {
    return await inSpan(
      "job.duplicate_suggest",
      { "northstar.embed.model": STORED_EMBED_MODEL },
      (span) =>
        db.transaction(async (tx) => {
          const [row] = await tx
            .insert(jobDuplicateSuggestion)
            .values({
              candidateId: input.candidateId,
              jobA,
              jobB,
              model: STORED_EMBED_MODEL,
              similarity: input.similarity,
            })
            .onConflictDoNothing()
            .returning({
              id: jobDuplicateSuggestion.id,
              createdAt: jobDuplicateSuggestion.createdAt,
            });
          if (row === undefined) return { status: "exists" } as const;
          await appendEvent(tx, span, {
            candidateId: input.candidateId,
            aggregate: `job:${jobA}`,
            type: "job.duplicate_suggested",
            actor: "system",
            reason: DUPLICATE_SUGGESTED_REASON,
            // Ids and the similarity only: never a title, company or the text compared.
            payload: {
              suggestionId: row.id,
              jobA,
              jobB,
              similarity: Math.round(input.similarity * 1000) / 1000,
            },
            idempotencyKey: `job_duplicate_suggestion:${row.id}`,
            at: row.createdAt,
          });
          return { status: "stored" } as const;
        }),
    );
  } catch (error) {
    if (error instanceof RangeError) throw error;
    // A fresh error with no cause: the driver's message lists the query's parameters.
    throw new Error("job.duplicate_suggest failed");
  }
}

export type EmbeddableJob = {
  jobId: string;
  title: string | null;
  company: string | null;
  requirements: string[];
};

// The candidate's ready, open jobs in the shape `embeddingText` reads, freshest first (posted, else
// first seen), so a pass that stops early has embedded the newest jobs. Employer text only.
export async function readEmbeddableJobs(
  db: Db,
  candidateId: CandidateId,
): Promise<EmbeddableJob[]> {
  const closed = await readClosedJobIds(db, candidateId);
  const rows = await db
    .select({
      jobId: job.id,
      title: job.title,
      company: company.name,
      requirements: job.requirements,
    })
    .from(job)
    .leftJoin(company, eq(company.id, job.companyId))
    .where(and(eq(job.candidateId, candidateId), eq(job.status, "ready")))
    .orderBy(desc(sql`coalesce(${job.postedAt}, ${job.firstSeenAt})`), job.id);
  return rows.filter((r) => !closed.has(r.jobId));
}

export type DuplicateSuggestionItem = {
  suggestionId: string;
  similarity: number;
  suggestedAt: Date;
  jobs: [SuggestedJob, SuggestedJob];
};
export type SuggestedJob = { jobId: string; title: string | null; company: string | null };

// The newest suggestions (at most 50), each with both jobs' titles and companies, for Paul's
// `jobs dupes`. Read-only; the names are read here at display time, never stored with the pair.
export async function listDuplicateSuggestions(
  db: Db,
  candidateId: CandidateId,
): Promise<DuplicateSuggestionItem[]> {
  const rows = await db
    .select({
      suggestionId: jobDuplicateSuggestion.id,
      similarity: jobDuplicateSuggestion.similarity,
      suggestedAt: jobDuplicateSuggestion.createdAt,
      jobA: jobDuplicateSuggestion.jobA,
      jobB: jobDuplicateSuggestion.jobB,
    })
    .from(jobDuplicateSuggestion)
    .where(eq(jobDuplicateSuggestion.candidateId, candidateId))
    .orderBy(desc(jobDuplicateSuggestion.position))
    .limit(50);
  const ids = [...new Set(rows.flatMap((r) => [r.jobA, r.jobB]))];
  const names =
    ids.length === 0
      ? []
      : await db
          .select({ jobId: job.id, title: job.title, company: company.name })
          .from(job)
          .leftJoin(company, eq(company.id, job.companyId))
          .where(and(eq(job.candidateId, candidateId), inArray(job.id, ids)));
  const byId = new Map(names.map((n) => [n.jobId, n]));
  const named = (jobId: string): SuggestedJob => {
    const n = byId.get(jobId);
    return { jobId, title: n?.title ?? null, company: n?.company ?? null };
  };
  return rows.map((r) => ({
    suggestionId: r.suggestionId,
    similarity: r.similarity,
    suggestedAt: r.suggestedAt,
    jobs: [named(r.jobA), named(r.jobB)],
  }));
}
