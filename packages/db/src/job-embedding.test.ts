import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { jobDuplicateSuggestion, jobEmbedding } from "./job-embedding-schema.js";
import {
  DUPLICATE_SUGGESTED_REASON,
  findSimilarJobs,
  listDuplicateSuggestions,
  readEmbeddableJobs,
  readEmbeddingHashes,
  recordDuplicateSuggestion,
  saveJobEmbedding,
} from "./job-embedding-write.js";
import { postingCheck } from "./liveness-schema.js";
import { domainEvent, job } from "./schema.js";
import { createTestDb, seedApplication, sqlState } from "./test/pglite.js";

// Job embeddings and duplicate suggestions (NS-129 slice 2). Synthetic jobs and made-up vectors.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let companyId: string;
let jobId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "queued");
  candidateId = CandidateId.parse(seeded.candidateId);
  companyId = seeded.companyId;
  jobId = seeded.jobId;
});

afterEach(async () => {
  await close();
});

// A 512-number vector pointing mostly along one axis, with a little of a second: two vectors on
// the same axis are alike, on different axes they're not.
function vec(axis: number, tilt = 0): number[] {
  const v = new Array(512).fill(0);
  v[axis] = 1;
  v[(axis + 1) % 512] = tilt;
  return v;
}
const sha = (c: string) => c.repeat(64);

async function addJob(title: string): Promise<string> {
  const [row] = await db
    .insert(job)
    .values({
      candidateId,
      companyId,
      title,
      url: `https://jobs.example.com/${encodeURIComponent(title)}`,
    })
    .returning({ id: job.id });
  if (!row) throw new Error("no job");
  return row.id;
}

const save = (id: string, embedding: number[], textSha256 = sha("a")) =>
  saveJobEmbedding(db, { candidateId, jobId: id, textSha256, embedding });

// Two closed answers in a row close a posting (NS-173).
async function closePosting(id: string): Promise<void> {
  for (const at of ["2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z"]) {
    await db
      .insert(postingCheck)
      .values({ candidateId, jobId: id, outcome: "closed", checkedAt: new Date(at) });
  }
}

describe("saveJobEmbedding (NS-129)", () => {
  it("stores a ready job's vector once per text", async () => {
    expect(await save(jobId, vec(0))).toEqual({ ok: true, value: { status: "stored" } });
    expect(await save(jobId, vec(0))).toEqual({ ok: true, value: { status: "unchanged" } });
    expect(await db.select().from(jobEmbedding)).toHaveLength(1);
  });

  it("stores a new row when the job's text changed, and the newest one is current", async () => {
    await save(jobId, vec(0), sha("a"));
    await save(jobId, vec(1), sha("b"));
    expect(await readEmbeddingHashes(db, candidateId, [jobId])).toEqual(
      new Map([[jobId, sha("b")]]),
    );
  });

  it("stores a text the job held before again, so the newest row is always its text now", async () => {
    expect([
      await save(jobId, vec(0), sha("a")),
      await save(jobId, vec(1), sha("b")),
      await save(jobId, vec(0), sha("a")),
    ]).toEqual([
      { ok: true, value: { status: "stored" } },
      { ok: true, value: { status: "stored" } },
      { ok: true, value: { status: "stored" } },
    ]);
    expect(await readEmbeddingHashes(db, candidateId, [jobId])).toEqual(
      new Map([[jobId, sha("a")]]),
    );
  });

  it("refuses a zero vector, which has no direction to compare", async () => {
    expect(await save(jobId, new Array(512).fill(0))).toEqual({
      ok: false,
      error: { kind: "InvalidEmbedding", field: "embedding" },
    });
  });

  it("refuses a vector of the wrong size, a non-finite number or a bad hash", async () => {
    expect([
      await save(jobId, [0.1, 0.2]),
      await save(jobId, [...vec(0).slice(1), Number.NaN]),
      await save(jobId, vec(0), "not-a-hash"),
    ]).toEqual([
      { ok: false, error: { kind: "InvalidEmbedding", field: "embedding" } },
      { ok: false, error: { kind: "InvalidEmbedding", field: "embedding" } },
      { ok: false, error: { kind: "InvalidEmbedding", field: "textSha256" } },
    ]);
  });

  it("refuses a draft job or another candidate's job", async () => {
    const draft = await addJob("Draft Role");
    await db
      .update(job)
      .set({ status: "draft", title: null, missingFields: ["title"] })
      .where(eq(job.id, draft));
    const other = await seedApplication(db, "queued");
    expect([await save(draft, vec(0)), await save(other.jobId, vec(0))]).toEqual([
      { ok: false, error: { kind: "JobNotReady" } },
      { ok: false, error: { kind: "JobNotReady" } },
    ]);
  });

  it("writes no domain event: a vector says nothing to Paul", async () => {
    await save(jobId, vec(0));
    expect(await db.select().from(domainEvent).where(eq(domainEvent.type, "job.embedded"))).toEqual(
      [],
    );
  });
});

describe("readEmbeddingHashes (NS-129)", () => {
  it("leaves out jobs with no vector", async () => {
    const other = await addJob("Data Engineer");
    await save(jobId, vec(0));
    expect(await readEmbeddingHashes(db, candidateId, [jobId, other])).toEqual(
      new Map([[jobId, sha("a")]]),
    );
  });
});

describe("findSimilarJobs (NS-129)", () => {
  it("gives the other jobs at least the threshold alike, most alike first", async () => {
    const near = await addJob("Backend Engineer II");
    const nearer = await addJob("Backend Engineer, Platform");
    const far = await addJob("Product Designer");
    await save(jobId, vec(0));
    await save(near, vec(0, 0.5));
    await save(nearer, vec(0, 0.1));
    await save(far, vec(7));
    const found = await findSimilarJobs(db, { candidateId, jobId, minSimilarity: 0.8, limit: 10 });
    expect(found.map((f) => f.jobId)).toEqual([nearer, near]);
    expect(found[0]?.similarity).toBeCloseTo(1 / Math.sqrt(1.01), 5);
  });

  it("compares only each job's newest vector", async () => {
    const other = await addJob("Backend Engineer II");
    await save(jobId, vec(0));
    await save(other, vec(0), sha("a"));
    // The other job's text changed and now points elsewhere.
    await save(other, vec(9), sha("b"));
    expect(
      await findSimilarJobs(db, { candidateId, jobId, minSimilarity: 0.5, limit: 10 }),
    ).toEqual([]);
  });

  it("leaves out a job whose posting is closed", async () => {
    const other = await addJob("Backend Engineer II");
    await save(jobId, vec(0));
    await save(other, vec(0));
    for (const at of ["2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z"]) {
      await db
        .insert(postingCheck)
        .values({ candidateId, jobId: other, outcome: "closed", checkedAt: new Date(at) });
    }
    expect(
      await findSimilarJobs(db, { candidateId, jobId, minSimilarity: 0.5, limit: 10 }),
    ).toEqual([]);
  });

  it("fills its limit with open jobs when the most alike one is closed", async () => {
    const closedJob = await addJob("Backend Engineer II");
    const open = await addJob("Backend Engineer, Platform");
    await save(jobId, vec(0));
    await save(closedJob, vec(0));
    await save(open, vec(0, 0.2));
    await closePosting(closedJob);
    expect(
      (await findSimilarJobs(db, { candidateId, jobId, minSimilarity: 0.5, limit: 1 })).map(
        (f) => f.jobId,
      ),
    ).toEqual([open]);
  });

  it("raises nothing for a job whose own posting is closed", async () => {
    const other = await addJob("Backend Engineer II");
    await save(jobId, vec(0));
    await save(other, vec(0));
    await closePosting(jobId);
    expect(
      await findSimilarJobs(db, { candidateId, jobId, minSimilarity: 0.5, limit: 10 }),
    ).toEqual([]);
  });

  it("is empty for a job with no vector", async () => {
    const other = await addJob("Backend Engineer II");
    await save(other, vec(0));
    expect(await findSimilarJobs(db, { candidateId, jobId, minSimilarity: 0, limit: 10 })).toEqual(
      [],
    );
  });

  it("never compares with another candidate's jobs", async () => {
    const other = await seedApplication(db, "queued");
    await save(jobId, vec(0));
    await saveJobEmbedding(db, {
      candidateId: CandidateId.parse(other.candidateId),
      jobId: other.jobId,
      textSha256: sha("a"),
      embedding: vec(0),
    });
    expect(await findSimilarJobs(db, { candidateId, jobId, minSimilarity: 0, limit: 10 })).toEqual(
      [],
    );
  });
});

describe("recordDuplicateSuggestion (NS-129)", () => {
  it("stores a pair once, whichever way round, with one fixed-word event", async () => {
    const other = await addJob("Backend Engineer II");
    expect(
      await recordDuplicateSuggestion(db, {
        candidateId,
        jobIds: [jobId, other],
        similarity: 0.91234,
      }),
    ).toEqual({
      status: "stored",
    });
    expect(
      await recordDuplicateSuggestion(db, {
        candidateId,
        jobIds: [other, jobId],
        similarity: 0.95,
      }),
    ).toEqual({
      status: "exists",
    });
    const events = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.type, "job.duplicate_suggested"));
    const [a, b] = [jobId, other].sort();
    expect(events.map((e) => [e.reason, e.actor, e.payload])).toEqual([
      [
        DUPLICATE_SUGGESTED_REASON,
        "system",
        expect.objectContaining({ jobA: a, jobB: b, similarity: 0.912 }),
      ],
    ]);
    expect(await db.select().from(jobDuplicateSuggestion)).toHaveLength(1);
  });

  it("refuses a job paired with itself or a similarity outside 0 to 1", async () => {
    await expect(
      recordDuplicateSuggestion(db, { candidateId, jobIds: [jobId, jobId], similarity: 0.9 }),
    ).rejects.toThrow(RangeError);
    const other = await addJob("Backend Engineer II");
    await expect(
      recordDuplicateSuggestion(db, { candidateId, jobIds: [jobId, other], similarity: 1.2 }),
    ).rejects.toThrow(RangeError);
  });

  it("refuses another candidate's job", async () => {
    const other = await seedApplication(db, "queued");
    await expect(
      recordDuplicateSuggestion(db, { candidateId, jobIds: [jobId, other.jobId], similarity: 0.9 }),
    ).rejects.toThrow("job.duplicate_suggest failed");
  });
});

describe("the job_embedding and job_duplicate_suggestion tables", () => {
  it("refuse UPDATE, DELETE and TRUNCATE", async () => {
    const other = await addJob("Backend Engineer II");
    await save(jobId, vec(0));
    await recordDuplicateSuggestion(db, { candidateId, jobIds: [jobId, other], similarity: 0.9 });
    const states = [];
    for (const table of ["job_embedding", "job_duplicate_suggestion"]) {
      states.push(await sqlState(db.execute(sql.raw(`UPDATE ${table} SET created_at = now()`))));
      states.push(await sqlState(db.execute(sql.raw(`DELETE FROM ${table}`))));
      states.push(await sqlState(db.execute(sql.raw(`TRUNCATE ${table}`))));
    }
    expect(states).toEqual(new Array(6).fill(RESTRICT_VIOLATION));
  });

  it("refuse another model, a pair out of order and a bad hash", async () => {
    const other = await addJob("Backend Engineer II");
    const [a, b] = [jobId, other].sort() as [string, string];
    expect([
      await sqlState(
        db.insert(jobEmbedding).values({
          candidateId,
          jobId,
          model: "text-embedding-3-large",
          dimensions: 512,
          textSha256: sha("a"),
          embedding: vec(0),
        }),
      ),
      await sqlState(
        db.insert(jobEmbedding).values({
          candidateId,
          jobId,
          model: "text-embedding-3-small",
          dimensions: 512,
          textSha256: "ABC",
          embedding: vec(0),
        }),
      ),
      await sqlState(
        db.insert(jobDuplicateSuggestion).values({
          candidateId,
          jobA: b,
          jobB: a,
          model: "text-embedding-3-small",
          similarity: 0.9,
        }),
      ),
    ]).toEqual([CHECK_VIOLATION, CHECK_VIOLATION, CHECK_VIOLATION]);
  });
});

describe("readEmbeddableJobs (NS-129 slice 3)", () => {
  it("gives ready, open jobs with their company, freshest first", async () => {
    const older = await addJob("Data Engineer");
    await db
      .update(job)
      .set({ postedAt: new Date("2026-01-01T00:00:00Z") })
      .where(eq(job.id, older));
    const closedJob = await addJob("Closed Role");
    await closePosting(closedJob);
    const draft = await addJob("Draft Role");
    await db
      .update(job)
      .set({ status: "draft", title: null, missingFields: ["title"] })
      .where(eq(job.id, draft));
    const found = await readEmbeddableJobs(db, candidateId);
    expect(found.map((j) => [j.jobId, j.company])).toEqual([
      [jobId, "Example Corp"],
      [older, "Example Corp"],
    ]);
  });
});

describe("listDuplicateSuggestions (NS-129 slice 3)", () => {
  it("lists the newest suggestions with both jobs' titles and companies", async () => {
    const other = await addJob("Backend Engineer II");
    await recordDuplicateSuggestion(db, { candidateId, jobIds: [jobId, other], similarity: 0.9 });
    const [item] = await listDuplicateSuggestions(db, candidateId);
    const [a, b] = [jobId, other].sort();
    const title = (id: string | undefined) =>
      id === jobId ? "Backend Engineer" : "Backend Engineer II";
    expect(item?.jobs).toEqual([
      { jobId: a, title: title(a), company: "Example Corp" },
      { jobId: b, title: title(b), company: "Example Corp" },
    ]);
    expect(item?.similarity).toBeCloseTo(0.9, 5);
  });

  it("never lists another candidate's suggestions", async () => {
    const other = await addJob("Backend Engineer II");
    await recordDuplicateSuggestion(db, { candidateId, jobIds: [jobId, other], similarity: 0.9 });
    const stranger = await seedApplication(db, "queued");
    expect(await listDuplicateSuggestions(db, CandidateId.parse(stranger.candidateId))).toEqual([]);
  });
});
