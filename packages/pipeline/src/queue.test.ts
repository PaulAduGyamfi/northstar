import { randomUUID } from "node:crypto";
import {
  type Db,
  fitSchema,
  PREFERENCE_DEFAULTS,
  profileSchema,
  readEventsAfter,
  saveFitScore,
  savePreferences,
  schema,
  writeProfileImport,
} from "@northstar/db";
import { createTestDb } from "@northstar/db/testing";
import { CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_QUEUE_DAILY_CAP, queueKey, queueReadyJobs } from "./queue.js";

// The queueing rule (NS-280 slice 1) on the real write paths (PGlite). Synthetic jobs only.

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let companyId: string;
let preferenceId: string;
let sourceId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const [c] = await db
    .insert(schema.candidate)
    .values({ displayName: "Test Candidate" })
    .returning();
  if (!c) throw new Error("no candidate");
  candidateId = CandidateId.parse(c.id);
  const [co] = await db
    .insert(schema.company)
    .values({ candidateId, name: "Example Corp" })
    .returning();
  companyId = co?.id ?? "";
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
  const [source] = await db
    .select({ id: profileSchema.profileSource.id })
    .from(profileSchema.profileSource);
  sourceId = source?.id ?? "";
  await savePreferences(db, { candidateId, values: PREFERENCE_DEFAULTS, now: new Date() });
  const [pref] = await db
    .select({ id: fitSchema.searchPreference.id })
    .from(fitSchema.searchPreference);
  preferenceId = pref?.id ?? "";
});

afterEach(() => close());

// A ready job scored in the queue band; `hoursAgo` orders freshness.
async function queueBandJob(hoursAgo = 1): Promise<string> {
  const [j] = await db
    .insert(schema.job)
    .values({
      candidateId,
      companyId,
      title: "Backend Engineer",
      url: `https://jobs.example.com/${randomUUID()}`,
      status: "ready",
      firstSeenAt: new Date(Date.now() - hoursAgo * 3_600_000),
    })
    .returning();
  if (!j) throw new Error("no job");
  await saveFitScore(db, {
    candidateId,
    now: new Date(),
    jobId: j.id,
    preferenceId,
    preferenceVersion: 1,
    profileSourceId: sourceId,
    jobFingerprint: "f".repeat(64),
    score: 90,
    band: "queue",
    reason: "ok",
    stretch: false,
    components: {},
    evidence: {},
  });
  return j.id;
}

const applications = () =>
  db
    .select({ jobId: schema.application.jobId, status: schema.application.status })
    .from(schema.application);

describe("queueReadyJobs (NS-280 slice 1)", () => {
  it("queues each job in the queue band once, started by Northstar, even when run twice", async () => {
    const a = await queueBandJob(2);
    const b = await queueBandJob(1);
    const first = await queueReadyJobs(db, candidateId, { dailyCap: 10 });
    const second = await queueReadyJobs(db, candidateId, { dailyCap: 10 });
    const created = (await readEventsAfter(db, candidateId, 0n, 100))
      .map((e) => e.event)
      .filter((e) => e.type === "application.created")
      .map((e) => [e.payload.jobId, e.payload.to, e.payload.startedBy, e.idempotencyKey]);
    expect([first, second, created.sort()]).toEqual([
      { queued: 2, replayed: 0, capped: 0, missing: 0, taken: 0 },
      { queued: 0, replayed: 0, capped: 0, missing: 0, taken: 0 },
      [
        [a, "queued", "northstar", queueKey(a)],
        [b, "queued", "northstar", queueKey(b)],
      ].sort(),
    ]);
  });

  it("never queues more than the day's cap, freshest first, and leaves the rest for a later day", async () => {
    await queueBandJob(5);
    const fresh = await queueBandJob(1);
    const middle = await queueBandJob(3);
    const first = await queueReadyJobs(db, candidateId, { dailyCap: 2 });
    const again = await queueReadyJobs(db, candidateId, { dailyCap: 2 });
    expect([first, again, (await applications()).map((r) => r.jobId).sort()]).toEqual([
      { queued: 2, replayed: 0, capped: 1, missing: 0, taken: 0 },
      { queued: 0, replayed: 0, capped: 1, missing: 0, taken: 0 },
      [fresh, middle].sort(),
    ]);
  });

  it("holds the cap at APPLY-007's 25 a day whatever the caller asks", async () => {
    for (let i = 0; i < MAX_QUEUE_DAILY_CAP + 1; i++) await queueBandJob();
    const result = await queueReadyJobs(db, candidateId, { dailyCap: 1000 });
    expect([result.queued, result.capped]).toEqual([MAX_QUEUE_DAILY_CAP, 1]);
  });

  it("refuses a cap that isn't a whole number of at least 1", async () => {
    await expect(queueReadyJobs(db, candidateId, { dailyCap: 0 })).rejects.toThrow(RangeError);
  });
});
