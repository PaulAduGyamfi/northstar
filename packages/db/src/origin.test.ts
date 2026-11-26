import { ApplicationId, CandidateId } from "@northstar/domain";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { recordMailLink } from "./mail-link-write.js";
import { createApplication, readCreditReport, readOrigin } from "./origin-write.js";
import { application, domainEvent, job } from "./schema.js";
import { createTestDb, seedApplication } from "./test/pglite.js";
import { transitionApplication } from "./transition-application.js";

// Application origin and the credit report (NS-188, INB-007, INB-010). Synthetic jobs only.

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let companyId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "discovered");
  candidateId = CandidateId.parse(seeded.candidateId);
  companyId = seeded.companyId;
});

afterEach(async () => {
  await close();
});

let jobs = 0;
async function newJob(): Promise<string> {
  jobs += 1;
  const [j] = await db
    .insert(job)
    .values({ candidateId, companyId, title: "Engineer", url: `https://jobs.example.com/${jobs}` })
    .returning();
  if (!j) throw new Error("no job");
  return j.id;
}

async function created(
  startedBy: "northstar" | "outside" | "recruiter_inbound",
  key = `create:${jobs}`,
) {
  const result = await createApplication(db, {
    candidateId,
    jobId: await newJob(),
    status: "awaiting_approval",
    startedBy,
    idempotencyKey: key,
  });
  if (!result.ok) throw new Error(result.error.kind);
  return ApplicationId.parse(result.value.applicationId);
}

// Walks an application from awaiting_approval along the given statuses.
async function walk(id: ApplicationId, via: "auto" | "approved" | "by_hand", to: string[]) {
  let from = "awaiting_approval";
  for (const next of ["submitting", "submitted", ...to]) {
    const moved = await transitionApplication(db, {
      candidateId,
      applicationId: id,
      from: from as never,
      to: next as never,
      actor: "agent:apply",
      reason: "",
      inputsSummary: "",
      links: [],
      idempotencyKey: `${id}:${next}`,
      submittedVia: via,
    });
    if (!moved.ok) throw new Error(moved.error.kind);
    from = next;
  }
}

describe("createApplication", () => {
  it("writes the application and its created event with who started it, together", async () => {
    const id = await created("northstar", "create:one");
    const [row] = await db.select().from(application).where(eq(application.id, id));
    const events = await db.select().from(domainEvent);
    expect([row?.status, events.map((e) => [e.type, e.payload])]).toEqual([
      "awaiting_approval",
      [["application.created", { to: "awaiting_approval", startedBy: "northstar" }]],
    ]);
  });

  it("creates nothing new when repeated with the same key", async () => {
    const jobId = await newJob();
    const input = {
      candidateId,
      jobId,
      status: "awaiting_approval" as const,
      startedBy: "outside" as const,
      idempotencyKey: "create:same",
    };
    const first = await createApplication(db, input);
    const second = await createApplication(db, input);
    const apps = await db.select().from(application);
    expect([
      first.ok && second.ok && first.value.applicationId === second.value.applicationId,
      second.ok && second.value.replayed,
      apps.length,
    ]).toEqual([true, true, 2]);
  });
});

describe("readOrigin", () => {
  it("reads who started an application and how it went out", async () => {
    const id = await created("northstar");
    await walk(id, "auto", []);
    expect(await readOrigin(db, candidateId, id)).toEqual({
      startedBy: "northstar",
      submittedVia: "auto",
    });
  });

  it("knows neither for an application from before origins were recorded", async () => {
    const [legacy] = await db.select().from(application);
    expect(await readOrigin(db, candidateId, ApplicationId.parse(legacy?.id))).toEqual({
      startedBy: null,
      submittedVia: null,
    });
  });

  it("isn't changed by linking an email to the application", async () => {
    const id = await created("northstar");
    await walk(id, "approved", []);
    const before = await readOrigin(db, candidateId, id);
    await recordMailLink(db, {
      candidateId,
      message: {
        id: "18c2f0a1b2c3d4e5",
        threadId: "18c2f0a1b2c3d4e5",
        receivedAt: new Date("2026-11-26T10:00:00Z"),
      },
      decision: { kind: "linked", applicationId: id, step: "tag", senderVerified: true },
    });
    expect(await readOrigin(db, candidateId, id)).toEqual(before);
  });
});

describe("readCreditReport", () => {
  it("counts each stage reached per origin", async () => {
    const a = await created("northstar");
    await walk(a, "auto", ["in_process", "offer"]);
    const b = await created("northstar");
    await walk(b, "by_hand", ["in_process"]);
    const c = await created("outside");
    await walk(c, "by_hand", []);
    await created("recruiter_inbound");
    const report = await readCreditReport(db, candidateId);
    expect(report).toEqual({
      northstar: { applications: 1, submitted: 1, inProcess: 1, offer: 1 },
      northstar_by_hand: { applications: 1, submitted: 1, inProcess: 1, offer: 0 },
      outside: { applications: 1, submitted: 1, inProcess: 0, offer: 0 },
      recruiter_inbound: { applications: 1, submitted: 0, inProcess: 0, offer: 0 },
      // The seeded application, created before origins existed.
      unknown: { applications: 1, submitted: 0, inProcess: 0, offer: 0 },
    });
  });

  it("counts only the given candidate's applications", async () => {
    await created("northstar");
    const other = await seedApplication(db, "discovered");
    const report = await readCreditReport(db, CandidateId.parse(other.candidateId));
    expect([report.northstar.applications, report.unknown.applications]).toEqual([0, 1]);
  });
});
