import { randomUUID } from "node:crypto";
import { CandidateId } from "@northstar/domain";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { fitScore, searchPreference } from "./fit-schema.js";
import {
  type FitScoreInput,
  PREFERENCE_DEFAULTS,
  readAtomTexts,
  readFitScore,
  readPreferences,
  readScorableJobs,
  readScoreKeys,
  readScoringProfile,
  recordRescore,
  saveFitScore,
  savePreferences,
} from "./fit-write.js";
import { listJobs } from "./job-write.js";
import { experienceAtom, profileSource, skill } from "./profile-schema.js";
import { candidate, company, domainEvent, job } from "./schema.js";
import { createTestDb, sqlState } from "./test/pglite.js";

const CHECK_VIOLATION = "23514";
const NOW = new Date("2026-11-25T12:00:00Z");
const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  candidateId = CandidateId.parse(c.id);
});

afterEach(async () => {
  await close();
});

// Synthetic job and resume rows only (invented company, example.com links).
async function seedJob(status: "ready" | "draft" = "ready"): Promise<string> {
  // A ready job needs a company and a title (job_ready_complete); a draft has neither.
  const [co] =
    status === "ready"
      ? await db.insert(company).values({ candidateId, name: "Globex" }).returning()
      : [];
  const [j] = await db
    .insert(job)
    .values({
      candidateId,
      companyId: co?.id ?? null,
      title: status === "ready" ? "Backend Engineer" : null,
      status,
      missingFields: status === "ready" ? [] : ["title", "company"],
      url: `https://jobs.example.com/${status}-${randomUUID()}`,
      requirements: ["TypeScript"],
    })
    .returning();
  if (!j) throw new Error("no job");
  return j.id;
}

async function seedProfile(): Promise<{ sourceId: string; atomId: string }> {
  const [src] = await db
    .insert(profileSource)
    .values({ candidateId, kind: "resume", fileName: "resume.md", textSha256: "c".repeat(64) })
    .returning();
  if (!src) throw new Error("no source");
  const [atom] = await db
    .insert(experienceAtom)
    .values({
      candidateId,
      sourceId: src.id,
      what: "Built a payments API",
      how: ["TypeScript"],
      sourceQuote: "Built a payments API in TypeScript",
      position: 0,
    })
    .returning();
  if (!atom) throw new Error("no atom");
  await db.insert(skill).values({ candidateId, sourceId: src.id, name: "Go" });
  return { sourceId: src.id, atomId: atom.id };
}

const scoreInput = (
  jobId: string,
  preferenceId: string,
  profileSourceId: string,
  over: Partial<FitScoreInput> = {},
): FitScoreInput => ({
  jobId,
  preferenceId,
  preferenceVersion: 1,
  profileSourceId,
  jobFingerprint: FP_A,
  score: 82,
  band: "queue",
  reason: "ok",
  stretch: false,
  components: { title: 1, mustHave: 1, niceToHave: null, preference: 0.5 },
  evidence: { matched: [], unmatched: [] },
  ...over,
});

describe("search preferences", () => {
  it("has no preferences before the first save", async () => {
    expect(await readPreferences(db, candidateId)).toBeNull();
  });

  it("stores the first save as version 1 even when it equals the defaults", async () => {
    const r = await savePreferences(db, { candidateId, values: PREFERENCE_DEFAULTS, now: NOW });
    expect(r.status).toBe("saved");
    expect((await readPreferences(db, candidateId))?.version).toBe(1);
  });

  it("stores a change as the next version and keeps the old one", async () => {
    await savePreferences(db, { candidateId, values: PREFERENCE_DEFAULTS, now: NOW });
    const r = await savePreferences(db, {
      candidateId,
      values: { ...PREFERENCE_DEFAULTS, compFloor: 150_000 },
      now: NOW,
    });
    expect(r.status === "saved" && r.changed).toEqual(["compFloor"]);
    const current = await readPreferences(db, candidateId);
    expect([current?.version, current?.compFloor]).toEqual([2, 150_000]);
    expect((await db.select().from(searchPreference)).length).toBe(2);
  });

  it("stores nothing when the value is the same as the current one", async () => {
    const values = { ...PREFERENCE_DEFAULTS, titles: ["Backend Engineer"] };
    await savePreferences(db, { candidateId, values, now: NOW });
    const r = await savePreferences(db, { candidateId, values, now: NOW });
    expect(r.status).toBe("unchanged");
    expect((await db.select().from(searchPreference)).length).toBe(1);
  });

  it("records preferences.changed with field names and versions, never values", async () => {
    await savePreferences(db, { candidateId, values: PREFERENCE_DEFAULTS, now: NOW });
    await savePreferences(db, {
      candidateId,
      values: { ...PREFERENCE_DEFAULTS, compFloor: 171_717, dealbreakers: ["clearance"] },
      now: NOW,
    });
    const events = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.type, "preferences.changed"));
    expect(events.map((e) => e.payload)).toEqual([
      { fields: [], fromVersion: null, toVersion: 1 },
      { fields: ["dealbreakers", "compFloor"], fromVersion: 1, toVersion: 2 },
    ]);
    const all = JSON.stringify(events.map(({ position: _p, ...e }) => e));
    for (const s of ["171717", "clearance"]) expect(all).not.toContain(s);
  });

  it("refuses a suggest threshold above the queue threshold", async () => {
    const code = await sqlState(
      db.insert(searchPreference).values({ candidateId, version: 1, queueAt: 60, suggestAt: 70 }),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it("refuses a remote kind that doesn't exist", async () => {
    const code = await sqlState(
      db.insert(searchPreference).values({ candidateId, version: 1, remote: ["anywhere"] }),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });
});

describe("scoring inputs", () => {
  it("reads the current resume's atoms and skills", async () => {
    const { sourceId, atomId } = await seedProfile();
    expect(await readScoringProfile(db, candidateId)).toEqual({
      sourceId,
      atoms: [{ id: atomId, what: "Built a payments API", how: ["TypeScript"] }],
      skills: ["Go"],
    });
  });

  it("has no scoring profile before a resume import", async () => {
    expect(await readScoringProfile(db, candidateId)).toBeNull();
  });

  it("reads ready jobs only", async () => {
    const ready = await seedJob("ready");
    await seedJob("draft");
    expect((await readScorableJobs(db, candidateId)).map((j) => j.id)).toEqual([ready]);
  });
});

describe("fit scores", () => {
  let jobId: string;
  let preferenceId: string;
  let sourceId: string;
  let atomId: string;

  beforeEach(async () => {
    jobId = await seedJob();
    ({ sourceId, atomId } = await seedProfile());
    const r = await savePreferences(db, { candidateId, values: PREFERENCE_DEFAULTS, now: NOW });
    if (r.status !== "saved") throw new Error("no preferences");
    preferenceId = r.current.id;
  });

  it("stores one score when the same key is saved twice", async () => {
    const input = { ...scoreInput(jobId, preferenceId, sourceId), candidateId, now: NOW };
    expect(await saveFitScore(db, input)).toBe("saved");
    expect(await saveFitScore(db, input)).toBe("exists");
    expect((await db.select().from(fitScore)).length).toBe(1);
    const events = await db.select().from(domainEvent).where(eq(domainEvent.type, "job.scored"));
    expect(events.length).toBe(1);
  });

  it("stores a new score when the job's fingerprint changes", async () => {
    await saveFitScore(db, { ...scoreInput(jobId, preferenceId, sourceId), candidateId, now: NOW });
    const second = scoreInput(jobId, preferenceId, sourceId, { jobFingerprint: FP_B });
    expect(await saveFitScore(db, { ...second, candidateId, now: NOW })).toBe("saved");
    const keys = await readScoreKeys(db, { candidateId, preferenceId, profileSourceId: sourceId });
    expect(keys).toEqual(new Set([`${jobId}:${FP_A}`, `${jobId}:${FP_B}`]));
  });

  it("stores a new score for the same job under a new preference version", async () => {
    await saveFitScore(db, { ...scoreInput(jobId, preferenceId, sourceId), candidateId, now: NOW });
    const r = await savePreferences(db, {
      candidateId,
      values: { ...PREFERENCE_DEFAULTS, compFloor: 200_000 },
      now: NOW,
    });
    if (r.status !== "saved") throw new Error("no new version");
    const second = scoreInput(jobId, r.current.id, sourceId, { preferenceVersion: 2 });
    expect(await saveFitScore(db, { ...second, candidateId, now: NOW })).toBe("saved");
    expect((await db.select().from(fitScore)).length).toBe(2);
  });

  it("records job.scored with numbers and codes only", async () => {
    const input = scoreInput(jobId, preferenceId, sourceId, {
      band: "skip",
      reason: "dealbreaker",
      score: 40,
      evidence: { matched: [{ requirement: "Secret clearance", atomId, term: "TypeScript" }] },
    });
    await saveFitScore(db, { ...input, candidateId, now: NOW });
    const [event] = await db.select().from(domainEvent).where(eq(domainEvent.type, "job.scored"));
    expect(event?.payload).toEqual({
      fitScoreId: expect.any(String),
      score: 40,
      band: "skip",
      reason: "dealbreaker",
      stretch: false,
      preferenceVersion: 1,
      method: "rules",
    });
    expect(event?.reason).toBe("Skipped: dealbreaker");
    const { position: _p, ...stored } = event ?? { position: 0n };
    expect(JSON.stringify(stored)).not.toContain("clearance");
  });

  it("refuses a score outside 0 to 100", async () => {
    const input = scoreInput(jobId, preferenceId, sourceId, { score: 101 });
    const code = await sqlState(saveFitScore(db, { ...input, candidateId, now: NOW }));
    expect(code).toBe(CHECK_VIOLATION);
  });

  it("reads back the latest score with its preference version", async () => {
    await saveFitScore(db, { ...scoreInput(jobId, preferenceId, sourceId), candidateId, now: NOW });
    const later = new Date(NOW.getTime() + 60_000);
    const second = scoreInput(jobId, preferenceId, sourceId, { jobFingerprint: FP_B, score: 55 });
    await saveFitScore(db, { ...second, candidateId, now: later });
    const view = await readFitScore(db, { candidateId, jobId });
    expect([view?.score, view?.preferenceVersion, view?.scoredAt]).toEqual([55, 1, later]);
  });

  it("lists each job with its latest fit", async () => {
    await saveFitScore(db, { ...scoreInput(jobId, preferenceId, sourceId), candidateId, now: NOW });
    const [item] = await listJobs(db, candidateId);
    expect(item?.fit).toEqual({ score: 82, band: "queue", reason: "ok", stretch: false });
  });

  it("lists an unscored job with no fit", async () => {
    const [item] = await listJobs(db, candidateId);
    expect(item?.fit).toBeNull();
  });

  it("reads atom texts by id for display", async () => {
    const texts = await readAtomTexts(db, { candidateId, ids: [atomId] });
    expect(texts).toEqual(new Map([[atomId, "Built a payments API"]]));
  });

  it("records preferences.rescored with the counts", async () => {
    const preference = await readPreferences(db, candidateId);
    if (!preference) throw new Error("no preferences");
    const counts = { jobs: 14, queue: 3, suggest: 5, skip: 6 };
    await recordRescore(db, { candidateId, preference, counts, now: NOW });
    const [event] = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.type, "preferences.rescored"));
    expect([event?.payload, event?.reason]).toEqual([
      { version: 1, ...counts },
      "14 jobs re-scored",
    ]);
  });
});
