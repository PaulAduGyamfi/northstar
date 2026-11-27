import { CandidateId } from "@northstar/domain";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ageText, readAlertCandidates, recordAlertHeld, recordFreshAlert } from "./alert-write.js";
import type { Db } from "./db.js";
import { fitScore, searchPreference } from "./fit-schema.js";
import { profileSource } from "./profile-schema.js";
import { candidate, company, domainEvent, job, jobSource } from "./schema.js";
import { createTestDb } from "./test/pglite.js";

// Synthetic jobs and boards only (invented company, example.com links).
const NOW = new Date("2026-11-25T12:00:00Z");
// The caller passes now less the 60-minute freshness window (packages/sources).
const FRESH_SINCE = new Date("2026-11-25T11:00:00Z");

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let preferenceId: string;
let sourceId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  candidateId = CandidateId.parse(c.id);
  const [p] = await db
    .insert(searchPreference)
    .values({ candidateId, version: 1, createdAt: NOW })
    .returning();
  const [s] = await db
    .insert(profileSource)
    .values({ candidateId, kind: "resume", fileName: "resume.md", textSha256: "c".repeat(64) })
    .returning();
  if (!p || !s) throw new Error("no preference or source");
  preferenceId = p.id;
  sourceId = s.id;
});

afterEach(async () => {
  await close();
});

async function seedScoredJob(
  scores: { score: number; band: "queue" | "suggest" | "skip"; at: Date }[],
  sourceUrl = "https://boards.greenhouse.io/globex/jobs/123",
  times: { postedAt: Date | null; firstSeenAt: Date } = {
    postedAt: new Date("2026-11-25T11:48:00Z"),
    firstSeenAt: new Date("2026-11-25T11:50:00Z"),
  },
): Promise<string> {
  const [co] = await db.insert(company).values({ candidateId, name: "Globex" }).returning();
  const [j] = await db
    .insert(job)
    .values({
      candidateId,
      companyId: co?.id ?? null,
      title: "Backend Engineer",
      url: sourceUrl,
      postedAt: times.postedAt,
      firstSeenAt: times.firstSeenAt,
    })
    .returning();
  if (!j) throw new Error("no job");
  await db
    .insert(jobSource)
    .values({ candidateId, jobId: j.id, url: sourceUrl, method: "ats_api" });
  for (const [i, s] of scores.entries()) {
    await db.insert(fitScore).values({
      candidateId,
      jobId: j.id,
      preferenceId,
      profileSourceId: sourceId,
      jobFingerprint: String(i).repeat(64).slice(0, 64),
      score: s.score,
      band: s.band,
      reason: "fit",
      stretch: false,
      components: {},
      evidence: {},
      method: "rules",
      scoredAt: s.at,
    });
  }
  return j.id;
}

const alert = (jobId: string) => ({
  candidateId,
  jobId,
  score: 88,
  ageMinutes: 12,
  tier: 1 as const,
  now: NOW,
});

describe("readAlertCandidates", () => {
  it("lists a queue-band job with its times, score and source URLs", async () => {
    const jobId = await seedScoredJob([{ score: 88, band: "queue", at: NOW }]);
    expect(await readAlertCandidates(db, candidateId, FRESH_SINCE)).toEqual([
      {
        jobId,
        postedAt: new Date("2026-11-25T11:48:00Z"),
        firstSeenAt: new Date("2026-11-25T11:50:00Z"),
        score: 88,
        sourceUrls: ["https://boards.greenhouse.io/globex/jobs/123"],
        alerted: false,
        held: false,
      },
    ]);
  });

  it("goes by the latest score, so a job re-scored below the queue band drops out", async () => {
    await seedScoredJob([
      { score: 88, band: "queue", at: new Date("2026-11-25T11:00:00Z") },
      { score: 70, band: "suggest", at: NOW },
    ]);
    expect(await readAlertCandidates(db, candidateId, FRESH_SINCE)).toEqual([]);
  });

  it("shows a job already alerted or held", async () => {
    const jobId = await seedScoredJob([{ score: 88, band: "queue", at: NOW }]);
    await recordAlertHeld(db, alert(jobId));
    await recordFreshAlert(db, { ...alert(jobId), wasHeld: true });
    const [c] = await readAlertCandidates(db, candidateId, FRESH_SINCE);
    expect([c?.alerted, c?.held]).toEqual([true, true]);
  });
});

describe("readAlertCandidates' narrowing", () => {
  const URL = "https://boards.greenhouse.io/globex/jobs/";
  const old = {
    postedAt: new Date("2026-11-25T10:00:00Z"),
    firstSeenAt: new Date("2026-11-25T10:05:00Z"),
  };
  const ids = async () =>
    (await readAlertCandidates(db, candidateId, FRESH_SINCE)).map((c) => c.jobId);

  it("leaves out a queue-band job older than the window with no held alert", async () => {
    await seedScoredJob([{ score: 88, band: "queue", at: NOW }], `${URL}1`, old);
    expect(await ids()).toEqual([]);
  });

  it("still reads an old job whose held alert hasn't gone out, so it is sent after quiet hours", async () => {
    const jobId = await seedScoredJob([{ score: 88, band: "queue", at: NOW }], `${URL}2`, old);
    await recordAlertHeld(db, alert(jobId));
    const [c] = await readAlertCandidates(db, candidateId, FRESH_SINCE);
    expect([c?.jobId, c?.held, c?.alerted]).toEqual([jobId, true, false]);
  });

  it("leaves out an old job whose held alert was already sent", async () => {
    const jobId = await seedScoredJob([{ score: 88, band: "queue", at: NOW }], `${URL}3`, old);
    await recordAlertHeld(db, alert(jobId));
    await recordFreshAlert(db, { ...alert(jobId), wasHeld: true });
    expect(await ids()).toEqual([]);
  });

  it("judges a job with no posting date by when it was first seen", async () => {
    const recent = await seedScoredJob([{ score: 88, band: "queue", at: NOW }], `${URL}4`, {
      postedAt: null,
      firstSeenAt: new Date("2026-11-25T11:30:00Z"),
    });
    await seedScoredJob([{ score: 88, band: "queue", at: NOW }], `${URL}5`, {
      postedAt: null,
      firstSeenAt: new Date("2026-11-25T10:30:00Z"),
    });
    expect(await ids()).toEqual([recent]);
  });

  it("judges a dated job by its posting date, not when it was first seen", async () => {
    await seedScoredJob([{ score: 88, band: "queue", at: NOW }], `${URL}6`, {
      postedAt: new Date("2026-11-24T09:00:00Z"),
      firstSeenAt: new Date("2026-11-25T11:55:00Z"),
    });
    expect(await ids()).toEqual([]);
  });

  it("still reads a job posted in the future, which counts as just posted", async () => {
    const jobId = await seedScoredJob([{ score: 88, band: "queue", at: NOW }], `${URL}7`, {
      postedAt: new Date("2026-11-26T09:00:00Z"),
      firstSeenAt: new Date("2026-11-25T09:00:00Z"),
    });
    expect(await ids()).toEqual([jobId]);
  });

  it("treats a job exactly at the window's start as not fresh, as the alert rule does", async () => {
    await seedScoredJob([{ score: 88, band: "queue", at: NOW }], `${URL}8`, {
      postedAt: FRESH_SINCE,
      firstSeenAt: FRESH_SINCE,
    });
    expect(await ids()).toEqual([]);
  });
});

describe("recordFreshAlert", () => {
  it("stores one alert per job however often it is called", async () => {
    const jobId = await seedScoredJob([{ score: 88, band: "queue", at: NOW }]);
    expect(await recordFreshAlert(db, { ...alert(jobId), wasHeld: false })).toBe("recorded");
    expect(await recordFreshAlert(db, { ...alert(jobId), wasHeld: false })).toBe("exists");
    const rows = await db
      .select({ reason: domainEvent.reason, payload: domainEvent.payload })
      .from(domainEvent)
      .where(eq(domainEvent.type, "job.fresh_alert"));
    expect(rows).toEqual([
      {
        reason: "Posted 12 min ago · Fit 88 · ready to approve",
        payload: { jobId, score: 88, ageMinutes: 12, tier: 1, wasHeld: false },
      },
    ]);
  });

  it("says when an alert was held for quiet hours", async () => {
    const jobId = await seedScoredJob([{ score: 88, band: "queue", at: NOW }]);
    await recordFreshAlert(db, { ...alert(jobId), ageMinutes: 430, wasHeld: true });
    const [row] = await db
      .select({ reason: domainEvent.reason })
      .from(domainEvent)
      .where(eq(domainEvent.type, "job.fresh_alert"));
    expect(row?.reason).toBe("Posted 7 h ago · Fit 88 · held for quiet hours · ready to approve");
  });
});

describe("recordAlertHeld", () => {
  it("stores one held alert per job, with no title, company or URL", async () => {
    const jobId = await seedScoredJob([{ score: 88, band: "queue", at: NOW }]);
    expect(await recordAlertHeld(db, alert(jobId))).toBe("recorded");
    expect(await recordAlertHeld(db, alert(jobId))).toBe("exists");
    const rows = await db
      .select({ reason: domainEvent.reason, payload: domainEvent.payload })
      .from(domainEvent)
      .where(eq(domainEvent.type, "job.fresh_alert_held"));
    expect(rows).toEqual([
      {
        reason: "Fit 88 job posted 12 min ago: alert held for quiet hours",
        payload: { jobId, score: 88, ageMinutes: 12, tier: 1 },
      },
    ]);
  });
});

describe("ageText", () => {
  it("reads minutes under an hour, hours under two days, then days", () => {
    expect([ageText(0), ageText(59.9), ageText(60), ageText(47 * 60), ageText(72 * 60)]).toEqual([
      "0 min ago",
      "59 min ago",
      "1 h ago",
      "47 h ago",
      "3 days ago",
    ]);
  });

  it("reads a posting dated in the future as just posted", () => {
    expect(ageText(-5)).toBe("0 min ago");
  });
});
