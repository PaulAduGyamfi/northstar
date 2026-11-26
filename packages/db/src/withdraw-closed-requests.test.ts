import { ApplicationId, CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decideApprovals,
  listPendingApprovals,
  requestApproval,
  verifyApproval,
  withdrawApproval,
} from "./approval-write.js";
import type { Db } from "./db.js";
import { recordPostingCheck, withdrawClosedApplications } from "./liveness-write.js";
import { application, domainEvent, job, jobSource } from "./schema.js";
import { createTestDb, seedApplication, sqlState } from "./test/pglite.js";
import { transitionApplication } from "./transition-application.js";

// Closing the Gate request of an application withdrawn because its posting closed (NS-239), on
// PGlite. Synthetic jobs and ids only.

const CHECK_VIOLATION = "23514";
const SHA = "a".repeat(64);

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let jobId: string;
let applicationId: string;
let companyId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "queued");
  candidateId = CandidateId.parse(seeded.candidateId);
  jobId = seeded.jobId;
  applicationId = seeded.applicationId;
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
afterEach(() => close());

// The application's package round, as preparePackage leaves it: queued → package_ready (the key
// names the package), filed with the Gate, then awaiting_approval. Returns the request id.
async function fileRound(packageId: string, appId = applicationId): Promise<string> {
  const move = (from: "queued" | "package_ready", to: "package_ready" | "awaiting_approval") =>
    transitionApplication(db, {
      candidateId,
      applicationId: ApplicationId.parse(appId),
      from,
      to,
      actor: "system",
      reason: "Package round",
      inputsSummary: "",
      links: [],
      idempotencyKey: `application:${appId}:package:${packageId}:${to}`,
    });
  await move("queued", "package_ready");
  const filed = await requestApproval(db, {
    candidateId,
    kind: "application_package",
    subject: `application_package:${packageId}`,
    contentSha256: SHA,
    facts: null,
    actor: "system",
    idempotencyKey: `package:${packageId}`,
  });
  if (!filed.ok) throw new Error(filed.error.kind);
  await move("package_ready", "awaiting_approval");
  return filed.value.requestId;
}

const closeJob = async (id = jobId) => {
  await recordPostingCheck(db, { candidateId, jobId: id, ats: "greenhouse", outcome: "closed" });
  await recordPostingCheck(db, { candidateId, jobId: id, ats: "greenhouse", outcome: "closed" });
};

const PKG = "0b6f3f8e-6a55-4c7e-9a52-5d6b2f8a1c01";

describe("withdrawClosedApplications closes the Gate request too (NS-239)", () => {
  it("closes a withdrawn application's pending request, once, and says why", async () => {
    const requestId = await fileRound(PKG);
    await closeJob();
    const first = await withdrawClosedApplications(db, candidateId);
    const second = await withdrawClosedApplications(db, candidateId);
    const events = await db
      .select({ actor: domainEvent.actor, payload: domainEvent.payload })
      .from(domainEvent)
      .where(eq(domainEvent.type, "approval.withdrawn"));
    expect([
      first,
      second,
      await listPendingApprovals(db, candidateId),
      events.map((e) => [
        e.actor,
        (e.payload as Record<string, unknown>).withdrawnBy,
        (e.payload as Record<string, unknown>).reason,
      ]),
      requestId.length,
    ]).toEqual([
      { withdrawn: 1, failed: 0 },
      { withdrawn: 0, failed: 0 },
      [],
      [["system", "system", "posting_closed"]],
      36,
    ]);
  });

  it("closes an approval Paul already gave, so no gateway can act on it", async () => {
    const requestId = await fileRound(PKG);
    const decided = await decideApprovals(db, {
      candidateId,
      requestIds: [requestId],
      decision: "approve",
    });
    const decisionId =
      decided.ok && decided.value[0]?.result.ok ? decided.value[0].result.value.decisionId : "";
    await closeJob();
    await withdrawClosedApplications(db, candidateId);
    const verified = await verifyApproval(db, {
      candidateId,
      decisionId,
      kind: "application_package",
      subject: `application_package:${PKG}`,
      contentSha256: SHA,
    });
    expect(verified).toEqual({ ok: false, error: { kind: "Withdrawn" } });
  });

  it("closes a request an earlier pass left open, and leaves an open job's request alone", async () => {
    const requestId = await fileRound(PKG);
    await closeJob();
    // An earlier pass moved the application but stopped before the Gate.
    await transitionApplication(db, {
      candidateId,
      applicationId: ApplicationId.parse(applicationId),
      from: "awaiting_approval",
      to: "withdrawn",
      actor: "system",
      reason: "The job's posting closed before the application went out",
      inputsSummary: "",
      links: [],
      reasonCode: "posting_closed",
      idempotencyKey: `application:${applicationId}:posting_closed`,
    });
    // Another application whose job is still open.
    const other = await seedOtherApplication();
    const otherRequest = await fileRound("0b6f3f8e-6a55-4c7e-9a52-5d6b2f8a1c02", other);
    const result = await withdrawClosedApplications(db, candidateId);
    expect([
      result,
      (await listPendingApprovals(db, candidateId)).map((p) => p.requestId),
      requestId === otherRequest,
    ]).toEqual([{ withdrawn: 0, failed: 0 }, [otherRequest], false]);
  });
});

describe("withdrawApproval by the system (NS-239)", () => {
  it("refuses any kind but an application package, in code and in the database", async () => {
    const answer = await requestApproval(db, {
      candidateId,
      kind: "answer",
      subject: "answer:0b6f3f8e-6a55-4c7e-9a52-5d6b2f8a1c03",
      contentSha256: SHA,
      facts: null,
      actor: "system",
      idempotencyKey: "answer-1",
    });
    const id = answer.ok ? answer.value.requestId : "";
    expect([
      await withdrawApproval(db, { candidateId, requestId: id, by: "system" }),
      await sqlState(
        db.execute(
          sql`insert into approval_withdrawal (candidate_id, request_id, withdrawn_by, reason, withdrawn_at) values (${candidateId}, ${id}, 'system', 'posting_closed', now())`,
        ),
      ),
      await sqlState(
        db.execute(
          sql`insert into approval_withdrawal (candidate_id, request_id, withdrawn_by, reason, withdrawn_at) values (${candidateId}, ${id}, 'system', 'paul', now())`,
        ),
      ),
    ]).toEqual([{ ok: false, error: { kind: "NotFound" } }, CHECK_VIOLATION, CHECK_VIOLATION]);
  });
});

// A second application, on its own job, still open.
async function seedOtherApplication(): Promise<string> {
  const [j] = await db
    .insert(job)
    .values({ candidateId, companyId, title: "Other", url: "https://jobs.example.com/other" })
    .returning({ id: job.id });
  if (!j) throw new Error("no job");
  const [a] = await db
    .insert(application)
    .values({ candidateId, jobId: j.id, status: "queued" })
    .returning({ id: application.id });
  if (!a) throw new Error("no application");
  return a.id;
}
