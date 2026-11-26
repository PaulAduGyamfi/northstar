import { randomUUID } from "node:crypto";
import { CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { readFeed, readFeedNames } from "./feed-read.js";
import { domainEvent, job } from "./schema.js";
import { createTestDb, seedApplication } from "./test/pglite.js";

// The names shown next to feed lines (NS-189), on PGlite. Synthetic jobs only: seedApplication
// makes "Backend Engineer" at "Example Corp".
let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let jobId: string;
let applicationId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "queued");
  candidateId = CandidateId.parse(seeded.candidateId);
  jobId = seeded.jobId;
  applicationId = seeded.applicationId;
});

afterEach(async () => {
  await close();
});

const NAMED = { jobTitle: "Backend Engineer", company: "Example Corp" };

describe("readFeedNames", () => {
  it("names a job aggregate with its title and company", async () => {
    const names = await readFeedNames(db, candidateId, [`job:${jobId}`]);
    expect([...names]).toEqual([[`job:${jobId}`, NAMED]]);
  });

  it("names an application aggregate through its job", async () => {
    const names = await readFeedNames(db, candidateId, [`application:${applicationId}`]);
    expect([...names]).toEqual([[`application:${applicationId}`, NAMED]]);
  });

  it("gives a draft job without a company a null company", async () => {
    const [draft] = await db
      .insert(job)
      .values({
        candidateId,
        companyId: null,
        title: "Data Engineer",
        url: "https://jobs.example.com/draft",
        status: "draft",
        missingFields: ["company"],
      })
      .returning();
    if (!draft) throw new Error("no job");
    const names = await readFeedNames(db, candidateId, [`job:${draft.id}`]);
    expect(names.get(`job:${draft.id}`)).toEqual({ jobTitle: "Data Engineer", company: null });
  });

  it("never names another candidate's job or application", async () => {
    const other = await seedApplication(db, "queued");
    const names = await readFeedNames(db, candidateId, [
      `job:${other.jobId}`,
      `application:${other.applicationId}`,
    ]);
    expect(names.size).toBe(0);
  });

  it("skips other aggregate kinds, malformed ids and unknown ids without querying them", async () => {
    const names = await readFeedNames(db, candidateId, [
      `kill_switch:${jobId}`,
      "job:not-a-uuid",
      `job:${jobId}' or '1'='1`,
      `job:${randomUUID()}`,
    ]);
    expect(names.size).toBe(0);
  });
});

describe("readFeed", () => {
  it("carries each event's aggregate id", async () => {
    await db.insert(domainEvent).values({
      id: randomUUID(),
      candidateId,
      aggregate: `job:${jobId}`,
      type: "job.scored",
      actor: "agent:fit",
      reason: "",
      inputsSummary: "",
      payload: {},
      links: [],
      traceId: null,
      idempotencyKey: randomUUID(),
      occurredAt: new Date(),
    });
    const [item] = await readFeed(db, candidateId, { limit: 1 });
    expect(item?.aggregate).toBe(`job:${jobId}`);
  });
});
