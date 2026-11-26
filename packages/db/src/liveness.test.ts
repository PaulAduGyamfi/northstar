import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { readScorableJobs } from "./fit-write.js";
import { postingCheck } from "./liveness-schema.js";
import {
  type PostingOutcome,
  readClosedJobIds,
  readJobsToCheck,
  recordPostingCheck,
} from "./liveness-write.js";
import { domainEvent, job, jobSource } from "./schema.js";
import { createTestDb, seedApplication, sqlState } from "./test/pglite.js";

// Posting liveness (NS-173 slice 2). Synthetic jobs and boards only.

const RESTRICT_VIOLATION = "23001";
const GH_URL = "https://boards.greenhouse.io/examplecorp/jobs/4001";
// Cutoffs in the future: every attempt so far counts as "before" them, so only the rule decides.
const LATER = new Date(Date.now() + 60 * 60 * 1000);
const PAST = new Date("2000-01-01T00:00:00Z");

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let jobId: string;
let companyId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "discovered");
  candidateId = CandidateId.parse(seeded.candidateId);
  jobId = seeded.jobId;
  companyId = seeded.companyId;
  await db.insert(jobSource).values({
    candidateId,
    jobId,
    url: GH_URL,
    method: "ats_api",
    ats: "greenhouse",
    atsPostingId: "4001",
  });
});

afterEach(async () => {
  await close();
});

let added = 0;
// Another ready job with one source of its own; returns its id.
async function addJob(source: Partial<typeof jobSource.$inferInsert> = {}): Promise<string> {
  const [j] = await db
    .insert(job)
    .values({
      candidateId,
      companyId,
      title: "Other",
      url: `https://jobs.example.com/${Math.random()}`,
    })
    .returning({ id: job.id });
  if (!j) throw new Error("no job");
  await db.insert(jobSource).values({
    candidateId,
    jobId: j.id,
    url: `https://jobs.lever.co/examplecorp/0a0a0a0a-0000-4000-8000-00000000000${++added}`,
    method: "ats_api",
    ats: "lever",
    atsPostingId: `0a0a0a0a-0000-4000-8000-00000000000${added}`,
    ...source,
  });
  return j.id;
}

const due = (checkedBefore = LATER, closedCheckedBefore = PAST, limit = 50) =>
  readJobsToCheck(db, candidateId, { checkedBefore, closedCheckedBefore, limit });
const ids = async (p: ReturnType<typeof due>) => (await p).map((j) => j.jobId);
const record = (outcome: PostingOutcome, id = jobId) =>
  recordPostingCheck(db, { candidateId, jobId: id, ats: "greenhouse", outcome });

describe("readJobsToCheck", () => {
  it("lists a never-checked ready job with its ATS source", async () => {
    expect(await due()).toEqual([{ jobId, ats: "greenhouse", url: GH_URL }]);
  });

  it("skips a job tried since the cutoff, an unavailable attempt included", async () => {
    await record("unavailable");
    expect(await ids(due(PAST))).toEqual([]);
  });

  it("puts never-tried jobs first, then the oldest attempt, up to the limit", async () => {
    await record("open");
    const fresh = await addJob();
    expect([await ids(due()), await ids(due(LATER, PAST, 1))]).toEqual([[fresh, jobId], [fresh]]);
  });

  it("leaves out a source the ATS's API didn't serve, one with no posting id, and a non-API ATS", async () => {
    await db.update(jobSource).set({ method: "jsonld" }).where(eq(jobSource.jobId, jobId));
    await addJob({ atsPostingId: null });
    await addJob({ ats: "workday" });
    expect(await due()).toEqual([]);
  });

  it("leaves out a draft job", async () => {
    await db
      .update(job)
      .set({ status: "draft", companyId: null, title: null })
      .where(eq(job.id, jobId));
    expect(await due()).toEqual([]);
  });

  it("re-checks a closed job only past the slower cutoff", async () => {
    await record("closed");
    await record("closed");
    expect([await ids(due(LATER, PAST)), await ids(due(LATER, LATER))]).toEqual([[], [jobId]]);
  });
});

describe("recordPostingCheck", () => {
  it("closes a job on its second closed answer in a row, skipping unavailable attempts", async () => {
    const results = [
      await record("closed"),
      await record("unavailable"),
      await record("closed"),
      await record("closed"),
    ];
    const events = await db
      .select({ type: domainEvent.type, payload: domainEvent.payload })
      .from(domainEvent)
      .where(eq(domainEvent.type, "job.closed"));
    expect([results.map((r) => r.closedNow), events]).toEqual([
      [false, false, true, false],
      [{ type: "job.closed", payload: { jobId, ats: "greenhouse" } }],
    ]);
  });

  it("reopens a closed job that answers open again, with one job.reopened event", async () => {
    await record("closed");
    await record("closed");
    const reopened = await record("open");
    const again = await record("open");
    const events = await db
      .select({ type: domainEvent.type })
      .from(domainEvent)
      .where(eq(domainEvent.type, "job.reopened"));
    expect([reopened.reopenedNow, again.reopenedNow, events.length]).toEqual([true, false, 1]);
  });

  it("refuses UPDATE, DELETE and TRUNCATE", async () => {
    await record("open");
    expect([
      await sqlState(db.update(postingCheck).set({ outcome: "closed" })),
      await sqlState(db.delete(postingCheck)),
      await sqlState(db.execute(sql`truncate posting_check`)),
    ]).toEqual([RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION]);
  });
});

describe("closed jobs", () => {
  it("stay scorable after one closed answer", async () => {
    await record("closed");
    expect([
      [...(await readClosedJobIds(db, candidateId))],
      (await readScorableJobs(db, candidateId)).map((j) => j.id),
    ]).toEqual([[], [jobId]]);
  });

  it("are read back by id and left out of scoring after two, and come back when reopened", async () => {
    await record("closed");
    await record("closed");
    const closed = [...(await readClosedJobIds(db, candidateId))];
    const scorable = (await readScorableJobs(db, candidateId)).map((j) => j.id);
    await record("open");
    const reopened = (await readScorableJobs(db, candidateId)).map((j) => j.id);
    expect([closed, scorable, reopened]).toEqual([[jobId], [], [jobId]]);
  });
});
