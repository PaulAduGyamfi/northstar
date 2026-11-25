import { CandidateId } from "@northstar/domain";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import {
  type JobFields,
  listJobs,
  readDedupeCandidates,
  saveIngestedJob,
  setJobField,
} from "./job-write.js";
import { candidate, domainEvent, job, jobSource } from "./schema.js";
import { createTestDb, sqlState } from "./test/pglite.js";

const CHECK_VIOLATION = "23514";

// Synthetic postings only (the repo is public).
const fields: JobFields = {
  title: "Backend Engineer",
  company: "Globex",
  location: "Remote, US",
  remote: "remote",
  salaryMin: 150000,
  salaryMax: 180000,
  salaryCurrency: "USD",
  salaryPeriod: "year",
  seniority: "senior",
  requirements: ["5+ years of TypeScript"],
  niceToHaves: ["Payments experience"],
  applyUrl: "https://boards.example.com/globex/jobs/1/apply",
  ats: "greenhouse",
  description: "Build payment APIs.",
  postedAt: new Date("2026-11-20T10:00:00Z"),
};
const source = {
  url: "https://boards.example.com/globex/jobs/1",
  method: "ats_api" as const,
  ats: "greenhouse" as const,
  atsPostingId: "1",
};

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

const events = () =>
  db
    .select()
    .from(domainEvent)
    .where(eq(domainEvent.candidateId, candidateId))
    .orderBy(domainEvent.position);

describe("saveIngestedJob", () => {
  it("stores a ready job, its company and its source, with a counts-only event", async () => {
    const result = await saveIngestedJob(db, { candidateId, fields, source, mergeInto: null });
    expect(result.status).toBe("created");
    const [row] = await db.select().from(job);
    expect(row).toMatchObject({ status: "ready", title: "Backend Engineer", missingFields: [] });
    expect(await db.select().from(jobSource)).toHaveLength(1);
    const [event] = await events();
    expect(event?.type).toBe("job.ingested");
    expect(event?.payload).toEqual({ method: "ats_api", fieldsFound: 13, draft: false });
  });

  it("the same source URL twice changes nothing", async () => {
    await saveIngestedJob(db, { candidateId, fields, source, mergeInto: null });
    const again = await saveIngestedJob(db, { candidateId, fields, source, mergeInto: null });
    expect(again.status).toBe("unchanged");
    expect(await db.select().from(job)).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });

  it("the same ATS posting at a new URL is unchanged too", async () => {
    await saveIngestedJob(db, { candidateId, fields, source, mergeInto: null });
    const other = { ...source, url: "https://boards.example.com/globex/jobs/1?gh_src=abc" };
    expect(
      (await saveIngestedJob(db, { candidateId, fields, source: other, mergeInto: null })).status,
    ).toBe("unchanged");
  });

  it("merging adds a second source to the existing job and records it", async () => {
    const first = await saveIngestedJob(db, { candidateId, fields, source, mergeInto: null });
    const careers = {
      url: "https://globex.example.com/careers/backend",
      method: "jsonld" as const,
      ats: null,
      atsPostingId: null,
    };
    const merged = await saveIngestedJob(db, {
      candidateId,
      fields,
      source: careers,
      mergeInto: first.jobId,
    });
    expect(merged).toEqual({ status: "merged", jobId: first.jobId });
    expect(await db.select().from(job)).toHaveLength(1);
    expect(await db.select().from(jobSource)).toHaveLength(2);
    expect((await events()).at(-1)).toMatchObject({ type: "job.merged", payload: { sources: 2 } });
  });

  it("stores a job without a title or company as a draft naming what's missing", async () => {
    await saveIngestedJob(db, {
      candidateId,
      fields: { ...fields, title: null, company: null },
      source,
      mergeInto: null,
    });
    const [row] = await db.select().from(job);
    expect(row).toMatchObject({
      status: "draft",
      companyId: null,
      missingFields: ["title", "company"],
    });
  });

  it("reuses a company with the same name, ignoring case", async () => {
    await saveIngestedJob(db, { candidateId, fields, source, mergeInto: null });
    const other = { ...source, url: "https://boards.example.com/globex/jobs/2", atsPostingId: "2" };
    await saveIngestedJob(db, {
      candidateId,
      fields: { ...fields, company: "GLOBEX" },
      source: other,
      mergeInto: null,
    });
    const rows = await db.select().from(job);
    expect(new Set(rows.map((r) => r.companyId)).size).toBe(1);
  });

  it("the event holds counts and the method only, no title, company or text", async () => {
    await saveIngestedJob(db, { candidateId, fields, source, mergeInto: null });
    const [event] = await events();
    const text = JSON.stringify([event?.payload, event?.reason, event?.inputsSummary]);
    for (const value of ["Backend", "Globex", "payment", "boards.example.com"])
      expect(text).not.toContain(value);
  });
});

describe("setJobField", () => {
  it("filling a draft's last missing field makes it ready and records it", async () => {
    const { jobId } = await saveIngestedJob(db, {
      candidateId,
      fields: { ...fields, title: null },
      source,
      mergeInto: null,
    });
    expect(
      await setJobField(db, { candidateId, jobId, field: "title", value: "Backend Engineer" }),
    ).toEqual({
      ok: true,
      value: { status: "ready", missingFields: [] },
    });
    expect((await events()).at(-1)?.type).toBe("job.draft_completed");
  });

  it("refuses a field that isn't editable and a malformed value", async () => {
    const { jobId } = await saveIngestedJob(db, { candidateId, fields, source, mergeInto: null });
    expect(await setJobField(db, { candidateId, jobId, field: "url", value: "x" })).toEqual({
      ok: false,
      error: { kind: "NotEditable", field: "url" },
    });
    expect(
      await setJobField(db, { candidateId, jobId, field: "salaryMin", value: "lots" }),
    ).toEqual({
      ok: false,
      error: { kind: "BadValue", field: "salaryMin" },
    });
  });
});

describe("reads", () => {
  it("readDedupeCandidates returns each job's company, title, location and description", async () => {
    const { jobId } = await saveIngestedJob(db, { candidateId, fields, source, mergeInto: null });
    expect(await readDedupeCandidates(db, candidateId)).toEqual([
      {
        jobId,
        company: "Globex",
        title: "Backend Engineer",
        location: "Remote, US",
        description: "Build payment APIs.",
        sources: [{ url: source.url, ats: "greenhouse", atsPostingId: "1" }],
      },
    ]);
  });

  it("listJobs puts the newest posting first", async () => {
    await saveIngestedJob(db, { candidateId, fields, source, mergeInto: null });
    const newer = { ...source, url: "https://boards.example.com/globex/jobs/2", atsPostingId: "2" };
    await saveIngestedJob(db, {
      candidateId,
      fields: { ...fields, title: "Data Engineer", postedAt: new Date("2026-11-24T10:00:00Z") },
      source: newer,
      mergeInto: null,
    });
    expect((await listJobs(db, candidateId)).map((j) => j.title)).toEqual([
      "Data Engineer",
      "Backend Engineer",
    ]);
  });

  it("the database refuses a ready job without a company", async () => {
    const bad = db
      .insert(job)
      .values({ candidateId, title: "X", url: "https://example.com/x", status: "ready" });
    expect(await sqlState(bad)).toBe(CHECK_VIOLATION);
  });
});
