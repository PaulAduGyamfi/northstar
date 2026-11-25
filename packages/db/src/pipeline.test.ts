import { randomUUID } from "node:crypto";
import { ApplicationId, CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { listApplications, readApplicationTimeline } from "./pipeline-read.js";
import { application, domainEvent, job } from "./schema.js";
import { createTestDb, seedApplication } from "./test/pglite.js";
import { transitionApplication } from "./transition-application.js";

// The pipeline board and application timeline reads (NS-168), on PGlite. Synthetic jobs only.
let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let applicationId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "queued");
  candidateId = CandidateId.parse(seeded.candidateId);
  applicationId = seeded.applicationId;
});

afterEach(async () => {
  await close();
});

const move = (id: string, from: "queued" | "package_ready", to: "package_ready" | "withdrawn") =>
  transitionApplication(db, {
    candidateId,
    applicationId: ApplicationId.parse(id),
    from,
    to,
    actor: "agent:pipeline",
    reason: "",
    inputsSummary: "",
    links: [],
    idempotencyKey: randomUUID(),
  });

// A second application for the same candidate, on a draft job with no title.
async function secondApplication(): Promise<string> {
  const [j] = await db
    .insert(job)
    .values({
      candidateId,
      companyId: null,
      title: null,
      url: "https://jobs.example.com/draft",
      status: "draft",
      missingFields: ["title", "company"],
    })
    .returning();
  if (!j) throw new Error("no job");
  const [a] = await db
    .insert(application)
    .values({ candidateId, jobId: j.id, status: "discovered" })
    .returning();
  if (!a) throw new Error("no application");
  return a.id;
}

// An event about this application from another aggregate (a handoff, say), naming it in the payload.
async function eventNaming(id: string, type: string, owner: string = candidateId): Promise<void> {
  await db.insert(domainEvent).values({
    id: randomUUID(),
    candidateId: owner,
    aggregate: `apply_handoff:${randomUUID()}`,
    type,
    actor: "agent:apply",
    reason: "",
    inputsSummary: "",
    payload: { applicationId: id, ats: "greenhouse", reason: "captcha" },
    links: [],
    traceId: null,
    idempotencyKey: randomUUID(),
    occurredAt: new Date(),
  });
}

describe("listApplications", () => {
  it("lists the candidate's applications with title, company and status, newest change first", async () => {
    const second = await secondApplication();
    await move(applicationId, "queued", "package_ready");
    const list = await listApplications(db, candidateId);
    expect(list.map((a) => [a.applicationId, a.status, a.jobTitle, a.company])).toEqual([
      [applicationId, "package_ready", "Backend Engineer", "Example Corp"],
      [second, "discovered", null, null],
    ]);
  });

  it("never lists another candidate's applications", async () => {
    const other = await seedApplication(db, "queued");
    const list = await listApplications(db, candidateId);
    expect(list.map((a) => a.applicationId)).toEqual([applicationId]);
    expect(list.map((a) => a.applicationId)).not.toContain(other.applicationId);
  });
});

describe("readApplicationTimeline", () => {
  it("collects the application's own events and events naming it, oldest first, as feed lines", async () => {
    await move(applicationId, "queued", "package_ready");
    await eventNaming(applicationId, "handoff.opened");
    const timeline = await readApplicationTimeline(db, candidateId, applicationId);
    expect(timeline?.application.jobTitle).toBe("Backend Engineer");
    expect(timeline?.items.map((i) => [i.type, i.line])).toEqual([
      ["application.package_ready", "Application moved from queued to package ready"],
      ["handoff.opened", "Needs your hands: a Greenhouse form stopped at a CAPTCHA"],
    ]);
  });

  it("leaves out another application's events", async () => {
    const second = await secondApplication();
    await eventNaming(second, "handoff.opened");
    const timeline = await readApplicationTimeline(db, candidateId, applicationId);
    expect(timeline?.items).toEqual([]);
  });

  it("leaves out another candidate's event even when its payload names this application", async () => {
    const other = await seedApplication(db, "queued");
    await eventNaming(applicationId, "handoff.opened", other.candidateId);
    const timeline = await readApplicationTimeline(db, candidateId, applicationId);
    expect(timeline?.items).toEqual([]);
  });

  it("reads another candidate's application, or an unknown id, as not found", async () => {
    const other = await seedApplication(db, "queued");
    expect(await readApplicationTimeline(db, candidateId, other.applicationId)).toBeNull();
    expect(await readApplicationTimeline(db, candidateId, randomUUID())).toBeNull();
  });
});
