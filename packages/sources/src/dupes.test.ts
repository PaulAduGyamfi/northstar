import {
  type Db,
  jobDuplicateSuggestion,
  listJobs,
  saveIngestedJob,
  saveJobEmbedding,
} from "@northstar/db";
import { createTestDb, seedApplication } from "@northstar/db/testing";
import { CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_SUGGESTIONS_PER_JOB, suggestDuplicates } from "./dupes.js";

// Duplicate suggestions from stored vectors (NS-129 slice 2). Synthetic jobs, made-up vectors.

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let jobId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "queued");
  candidateId = CandidateId.parse(seeded.candidateId);
  jobId = seeded.jobId;
});

afterEach(async () => {
  await close();
});

function vec(axis: number, tilt = 0): number[] {
  const v = new Array(512).fill(0);
  v[axis] = 1;
  v[(axis + 1) % 512] = tilt;
  return v;
}

// A ready job saved through the real write path, with a vector.
async function jobWith(title: string, embedding: number[]): Promise<string> {
  const saved = await saveIngestedJob(db, {
    candidateId,
    fields: {
      title,
      company: "Example Corp",
      location: null,
      remote: null,
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      salaryPeriod: null,
      seniority: null,
      requirements: [],
      niceToHaves: [],
      applyUrl: null,
      ats: null,
      description: null,
      postedAt: null,
    },
    source: {
      url: `https://jobs.example.com/${encodeURIComponent(title)}`,
      method: "text",
      ats: null,
      atsPostingId: null,
    },
    mergeInto: null,
  });
  await saveJobEmbedding(db, {
    candidateId,
    jobId: saved.jobId,
    textSha256: "a".repeat(64),
    embedding,
  });
  return saved.jobId;
}

describe("suggestDuplicates (NS-129)", () => {
  it("suggests each job at least the threshold alike, once", async () => {
    await saveJobEmbedding(db, {
      candidateId,
      jobId,
      textSha256: "a".repeat(64),
      embedding: vec(0),
    });
    await jobWith("Backend Engineer II", vec(0, 0.1));
    await jobWith("Product Designer", vec(5));
    expect(await suggestDuplicates(db, candidateId, jobId, { threshold: 0.9 })).toEqual({
      suggested: 1,
      existing: 0,
    });
    expect(await suggestDuplicates(db, candidateId, jobId, { threshold: 0.9 })).toEqual({
      suggested: 0,
      existing: 1,
    });
  });

  it("raises at most a few suggestions per job, so one posting can't flood the feed", async () => {
    await saveJobEmbedding(db, {
      candidateId,
      jobId,
      textSha256: "a".repeat(64),
      embedding: vec(0),
    });
    for (let i = 0; i < MAX_SUGGESTIONS_PER_JOB + 2; i++) {
      await jobWith(`Backend Engineer ${i}`, vec(0, i / 100));
    }
    await suggestDuplicates(db, candidateId, jobId, { threshold: 0.5 });
    expect(await db.select().from(jobDuplicateSuggestion)).toHaveLength(MAX_SUGGESTIONS_PER_JOB);
  });

  it("never touches the jobs it suggests", async () => {
    await saveJobEmbedding(db, {
      candidateId,
      jobId,
      textSha256: "a".repeat(64),
      embedding: vec(0),
    });
    await jobWith("Backend Engineer II", vec(0));
    const before = await listJobs(db, candidateId);
    await suggestDuplicates(db, candidateId, jobId, { threshold: 0.9 });
    expect(await listJobs(db, candidateId)).toEqual(before);
  });
});
