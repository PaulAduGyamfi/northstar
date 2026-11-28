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
import { job } from "./schema.js";

// The job-embedding write path (NS-129 slice 2, SRC-006, ADR-0033). packages/sources decides what
// text is embedded and which pairs are alike enough; this module stores vectors and suggestions
// and compares stored vectors. A suggestion never merges, edits or deletes a job.

const SHA256 = /^[0-9a-f]{64}$/;

export type EmbeddingRefusal =
  | { kind: "InvalidEmbedding"; field: "embedding" | "textSha256" }
  // Not one of the candidate's ready jobs: only a ready job is compared.
  | { kind: "JobNotReady" };

// Stores a job's vector for its current text. The same text again stores nothing ("unchanged").
// No domain event: one per embedded job would flood the feed, and the vector says nothing to
// Paul. The suggestion it may lead to is the event.
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
    !input.embedding.every((n) => Number.isFinite(n))
  ) {
    return { ok: false, error: { kind: "InvalidEmbedding", field: "embedding" } };
  }
  return inSpan(
    "job.embedding_save",
    { "northstar.embed.model": STORED_EMBED_MODEL },
    async (span) => {
      const [ready] = await db
        .select({ id: job.id })
        .from(job)
        .where(
          and(
            eq(job.id, input.jobId),
            eq(job.candidateId, input.candidateId),
            eq(job.status, "ready"),
          ),
        );
      if (ready === undefined) return { ok: false, error: { kind: "JobNotReady" } } as const;
      const inserted = await db
        .insert(jobEmbedding)
        .values({
          candidateId: input.candidateId,
          jobId: input.jobId,
          model: STORED_EMBED_MODEL,
          dimensions: STORED_EMBED_DIMENSIONS,
          textSha256: input.textSha256,
          embedding: input.embedding,
        })
        .onConflictDoNothing()
        .returning({ id: jobEmbedding.id });
      const status = inserted.length > 0 ? "stored" : "unchanged";
      span.setAttribute("northstar.embed.status", status);
      return { ok: true, value: { status } } as const;
    },
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
  const limit = Math.max(1, Math.min(50, Math.floor(input.limit)));
  const closed = await readClosedJobIds(db, input.candidateId);
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
