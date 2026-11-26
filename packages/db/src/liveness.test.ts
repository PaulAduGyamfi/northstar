import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { readScorableJobs } from "./fit-write.js";
import { postingCheck } from "./liveness-schema.js";
import { readClosedJobIds, readJobsToCheck, recordPostingCheck } from "./liveness-write.js";
import { domainEvent, job, jobSource } from "./schema.js";
import { createTestDb, seedApplication, sqlState } from "./test/pglite.js";

// Posting liveness (NS-173 slice 2). Synthetic jobs and boards only.

const RESTRICT_VIOLATION = "23001";
const NOW = new Date("2026-11-26T12:00:00Z");
const DAY_AGO = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);

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
    url: "https://boards.greenhouse.io/examplecorp/jobs/4001",
    method: "ats_api",
    ats: "greenhouse",
    atsPostingId: "4001",
  });
});

afterEach(async () => {
  await close();
});

const due = () => readJobsToCheck(db, candidateId, { checkedBefore: DAY_AGO, limit: 50 });
const record = (outcome: "open" | "closed", id = jobId) =>
  recordPostingCheck(db, { candidateId, jobId: id, ats: "greenhouse", outcome });

describe("readJobsToCheck", () => {
  it("lists a never-checked ready job with its ATS source", async () => {
    expect(await due()).toEqual([
      { jobId, ats: "greenhouse", url: "https://boards.greenhouse.io/examplecorp/jobs/4001" },
    ]);
  });

  it("skips a job checked since the cutoff and a closed job", async () => {
    await record("open");
    const afterOpen = await due();
    const [other] = await db
      .insert(job)
      .values({
        candidateId,
        companyId,
        title: "Other",
        url: "https://jobs.lever.co/examplecorp/x",
      })
      .returning({ id: job.id });
    if (!other) throw new Error("no job");
    await db.insert(jobSource).values({
      candidateId,
      jobId: other.id,
      url: "https://jobs.lever.co/examplecorp/0a0a0a0a-0000-4000-8000-000000000002",
      method: "ats_api",
      ats: "lever",
      atsPostingId: "0a0a0a0a-0000-4000-8000-000000000002",
    });
    await record("closed", other.id);
    expect([
      afterOpen,
      await readJobsToCheck(db, candidateId, {
        checkedBefore: new Date(Date.now() + 60_000),
        limit: 50,
      }),
    ]).toEqual([
      [],
      [{ jobId, ats: "greenhouse", url: "https://boards.greenhouse.io/examplecorp/jobs/4001" }],
    ]);
  });

  it("skips a source with no checkable ATS", async () => {
    await db.update(jobSource).set({ ats: "workday" }).where(eq(jobSource.jobId, jobId));
    expect(await due()).toEqual([]);
  });
});

describe("recordPostingCheck", () => {
  it("writes one job.closed event when a job turns closed, and none for open or repeat", async () => {
    const first = await record("open");
    const closed = await record("closed");
    const again = await record("closed");
    const events = await db
      .select({ type: domainEvent.type, payload: domainEvent.payload })
      .from(domainEvent)
      .where(eq(domainEvent.type, "job.closed"));
    expect([first, closed, again, events]).toEqual([
      { closedNow: false },
      { closedNow: true },
      { closedNow: false },
      [{ type: "job.closed", payload: { jobId, ats: "greenhouse" } }],
    ]);
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
  it("are read back by id and left out of scoring; a reopened job comes back", async () => {
    await record("closed");
    const closed = await readClosedJobIds(db, candidateId);
    const scorable = (await readScorableJobs(db, candidateId)).map((j) => j.id);
    await record("open");
    const reopened = (await readScorableJobs(db, candidateId)).map((j) => j.id);
    expect([[...closed], scorable, reopened]).toEqual([[jobId], [], [jobId]]);
  });
});
