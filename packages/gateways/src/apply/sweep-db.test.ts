import {
  applySchema,
  CLAIM_STALE_AFTER_MS,
  claimSubmission,
  type Db,
  decideApprovals,
  requestApproval,
  schema,
} from "@northstar/db";
import { createTestDb, seedApplication, setGateClock } from "@northstar/db/testing";
import {
  type ApplicationStatus,
  CandidateId,
  packageSha256,
  packageSubject,
  UNDO_WINDOW_MS,
} from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbSweepPorts } from "./ports.js";
import { sweepStaleClaims } from "./stale.js";
import { makePackage } from "./test/fixtures.js";

// The stale-claim sweep (NS-143) on the real write paths: the ledger, transitionApplication and
// one event log on PGlite.

const NOW = new Date("2026-11-25T12:00:00Z");
const after = (ms: number) => new Date(NOW.getTime() + ms);
const STALE = after(UNDO_WINDOW_MS + CLAIM_STALE_AFTER_MS);

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let applicationId: string;
let companyId: string;
let pkg: ReturnType<typeof makePackage>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "awaiting_approval");
  candidateId = CandidateId.parse(seeded.candidateId);
  applicationId = seeded.applicationId;
  companyId = seeded.companyId;
  pkg = makePackage("greenhouse", { applicationId });
  await setGateClock(db, NOW);
});

afterEach(async () => {
  await close();
});

// Paul approves the package; returns the Gate's decision id, past the undo window.
async function approved(p: ReturnType<typeof makePackage>): Promise<string> {
  const requested = await requestApproval(db, {
    candidateId,
    kind: "application_package",
    subject: packageSubject(p),
    contentSha256: packageSha256(p),
    facts: null,
    actor: "agent:apply",
    idempotencyKey: `test:${p.packageId}`,
  });
  if (!requested.ok) throw new Error(requested.error.kind);
  const decided = await decideApprovals(db, {
    candidateId,
    requestIds: [requested.value.requestId],
    decision: "approve",
  });
  const outcome = decided.ok ? decided.value[0]?.result : undefined;
  if (!outcome?.ok) throw new Error("not approved");
  return outcome.value.decisionId;
}

// Paul approves the package and a run claims it, then dies. Returns the submission id.
async function deadRunClaim(): Promise<string> {
  const decisionId = await approved(pkg);
  await setGateClock(db, after(UNDO_WINDOW_MS));
  const claimed = await claimSubmission(db, {
    candidateId,
    applicationId,
    decisionId,
    ats: "greenhouse",
    postingId: pkg.postingId,
  });
  if (!claimed.ok || !claimed.value.claimed) throw new Error("not claimed");
  return claimed.value.submission.submissionId;
}

async function applicationStatus(): Promise<ApplicationStatus> {
  const rows = await db
    .select({ id: schema.application.id, status: schema.application.status })
    .from(schema.application);
  return rows.find((r) => r.id === applicationId)?.status as ApplicationStatus;
}

async function ledger(): Promise<{ status: string; reason: string | null }[]> {
  return db
    .select({
      status: applySchema.applySubmission.status,
      reason: applySchema.applySubmission.reason,
    })
    .from(applySchema.applySubmission);
}

async function eventTypes(): Promise<string[]> {
  const rows = await db
    .select({ type: schema.domainEvent.type, position: schema.domainEvent.position })
    .from(schema.domainEvent);
  return rows.sort((a, b) => Number(a.position) - Number(b.position)).map((r) => r.type);
}

describe("sweepStaleClaims", () => {
  it("hands a claim from a dead run to Paul as needs_human with outcome_unknown", async () => {
    const id = await deadRunClaim();
    await setGateClock(db, STALE);
    const closed = await sweepStaleClaims(dbSweepPorts(db), candidateId);
    expect([closed, await ledger(), await applicationStatus()]).toEqual([
      [id],
      [{ status: "needs_human", reason: "outcome_unknown" }],
      "needs_human",
    ]);
  });

  it("frees the ATS lane so another application on it can be claimed", async () => {
    await deadRunClaim();
    await setGateClock(db, STALE);
    await sweepStaleClaims(dbSweepPorts(db), candidateId);
    // A second application of the same candidate, to another job on the same ATS.
    const [otherJob] = await db
      .insert(schema.job)
      .values({ candidateId, companyId, title: "Data Engineer", url: "https://jobs.example.com/2" })
      .returning();
    if (!otherJob) throw new Error("no job");
    const [other] = await db
      .insert(schema.application)
      .values({ candidateId, jobId: otherJob.id, status: "awaiting_approval" })
      .returning();
    if (!other) throw new Error("no application");
    const next = makePackage("greenhouse", {
      packageId: "33333333-3333-4333-8333-333333333333",
      applicationId: other.id,
      postingId: "9999",
    });
    const decisionId = await approved(next);
    await setGateClock(db, after(2 * UNDO_WINDOW_MS + CLAIM_STALE_AFTER_MS));
    const claimed = await claimSubmission(db, {
      candidateId,
      applicationId: other.id,
      decisionId,
      ats: "greenhouse",
      postingId: "9999",
    });
    expect(claimed.ok && claimed.value.claimed).toBe(true);
  });

  it("leaves a claim younger than 15 minutes alone", async () => {
    await deadRunClaim();
    await setGateClock(db, after(UNDO_WINDOW_MS + CLAIM_STALE_AFTER_MS - 1_000));
    const closed = await sweepStaleClaims(dbSweepPorts(db), candidateId);
    expect([closed, await ledger(), await applicationStatus()]).toEqual([
      [],
      [{ status: "in_progress", reason: null }],
      "awaiting_approval",
    ]);
  });

  it("sweeping twice closes the claim once and writes its events once", async () => {
    await deadRunClaim();
    await setGateClock(db, STALE);
    await sweepStaleClaims(dbSweepPorts(db), candidateId);
    const once = await eventTypes();
    const second = await sweepStaleClaims(dbSweepPorts(db), candidateId);
    expect([second, await eventTypes()]).toEqual([[], once]);
  });

  it("moves an application its dead run never moved through submitting to needs_human", async () => {
    await deadRunClaim();
    await setGateClock(db, STALE);
    await sweepStaleClaims(dbSweepPorts(db), candidateId);
    const types = await eventTypes();
    expect(types.slice(-3)).toEqual([
      "apply_submission.needs_human",
      "application.submitting",
      "application.needs_human",
    ]);
  });
});
