import { randomUUID } from "node:crypto";
import { CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { searchPreference } from "./fit-schema.js";
import { PREFERENCE_DEFAULTS, saveFitScore, savePreferences } from "./fit-write.js";
import { recordPostingCheck } from "./liveness-write.js";
import { createApplication } from "./origin-write.js";
import { profileSource } from "./profile-schema.js";
import { writeProfileImport } from "./profile-write.js";
import { countQueuedToday, MAX_QUEUE_READ, readQueueCandidates } from "./queue-read.js";
import { candidate, company, job } from "./schema.js";
import { createTestDb } from "./test/pglite.js";

// The queueing rule's reads (NS-280 slice 1) on PGlite. Synthetic jobs on example.com only.

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let companyId: string;
let preferenceId: string;
let sourceId: string;

async function newCandidate(): Promise<{ candidateId: CandidateId; companyId: string }> {
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  const [co] = await db
    .insert(company)
    .values({ candidateId: c.id, name: "Example Corp" })
    .returning();
  if (!co) throw new Error("no company");
  return { candidateId: CandidateId.parse(c.id), companyId: co.id };
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  ({ candidateId, companyId } = await newCandidate());
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
  const [source] = await db.select({ id: profileSource.id }).from(profileSource);
  sourceId = source?.id ?? "";
  await savePreferences(db, { candidateId, values: PREFERENCE_DEFAULTS, now: new Date() });
  const [pref] = await db.select({ id: searchPreference.id }).from(searchPreference);
  preferenceId = pref?.id ?? "";
});

afterEach(() => close());

// A job, ready unless told otherwise, first seen `hoursAgo` hours ago.
async function newJob(
  options: { status?: "ready" | "draft"; hoursAgo?: number } = {},
): Promise<string> {
  const [j] = await db
    .insert(job)
    .values({
      candidateId,
      companyId,
      title: "Backend Engineer",
      url: `https://jobs.example.com/${randomUUID()}`,
      status: options.status ?? "ready",
      firstSeenAt: new Date(Date.now() - (options.hoursAgo ?? 1) * 3_600_000),
    })
    .returning();
  if (!j) throw new Error("no job");
  return j.id;
}

// A score of the job in `band`, `minutesAgo` minutes ago (a distinct fingerprint per score).
async function score(jobId: string, band: "queue" | "suggest" | "skip", minutesAgo = 10) {
  await saveFitScore(db, {
    candidateId,
    now: new Date(Date.now() - minutesAgo * 60_000),
    jobId,
    preferenceId,
    preferenceVersion: 1,
    profileSourceId: sourceId,
    jobFingerprint: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    score: band === "queue" ? 90 : band === "suggest" ? 70 : 20,
    band,
    reason: "ok",
    stretch: false,
    components: {},
    evidence: {},
  });
}

describe("readQueueCandidates (NS-280 slice 1)", () => {
  it("lists a ready job whose newest score is in the queue band", async () => {
    const id = await newJob();
    await score(id, "queue");
    expect(await readQueueCandidates(db, candidateId)).toEqual([id]);
  });

  it("lists the freshest job first", async () => {
    const older = await newJob({ hoursAgo: 5 });
    const newer = await newJob({ hoursAgo: 1 });
    await score(older, "queue");
    await score(newer, "queue");
    expect(await readQueueCandidates(db, candidateId)).toEqual([newer, older]);
  });

  it("leaves out a job whose newer score left the queue band, and lists one whose newer score entered it", async () => {
    const left = await newJob();
    await score(left, "queue", 30);
    await score(left, "suggest", 5);
    const entered = await newJob();
    await score(entered, "skip", 30);
    await score(entered, "queue", 5);
    expect(await readQueueCandidates(db, candidateId)).toEqual([entered]);
  });

  it("leaves out a draft, a job already applied to and a closed posting", async () => {
    const draft = await newJob({ status: "draft" });
    const applied = await newJob();
    const closed = await newJob();
    for (const id of [draft, applied, closed]) await score(id, "queue");
    await createApplication(db, {
      candidateId,
      jobId: applied,
      status: "queued",
      startedBy: "outside",
      idempotencyKey: randomUUID(),
    });
    for (let i = 0; i < 2; i++) {
      await recordPostingCheck(db, {
        candidateId,
        jobId: closed,
        ats: "greenhouse",
        outcome: "closed",
      });
    }
    expect(await readQueueCandidates(db, candidateId)).toEqual([]);
  });

  it("never lists another candidate's job", async () => {
    const id = await newJob();
    await score(id, "queue");
    const other = await newCandidate();
    expect(await readQueueCandidates(db, other.candidateId)).toEqual([]);
  });

  it("reads at most MAX_QUEUE_READ jobs a pass", async () => {
    for (let i = 0; i < MAX_QUEUE_READ + 1; i++) await score(await newJob(), "queue");
    expect((await readQueueCandidates(db, candidateId)).length).toBe(MAX_QUEUE_READ);
  });
});

describe("countQueuedToday (NS-280 slice 1)", () => {
  it("counts only applications Northstar created at queued", async () => {
    const mine = await newJob();
    const outside = await newJob();
    const scored = await newJob();
    await createApplication(db, {
      candidateId,
      jobId: mine,
      status: "queued",
      startedBy: "northstar",
      idempotencyKey: randomUUID(),
    });
    await createApplication(db, {
      candidateId,
      jobId: outside,
      status: "queued",
      startedBy: "outside",
      idempotencyKey: randomUUID(),
    });
    await createApplication(db, {
      candidateId,
      jobId: scored,
      status: "scored",
      startedBy: "northstar",
      idempotencyKey: randomUUID(),
    });
    expect(await countQueuedToday(db, candidateId)).toBe(1);
  });
});
