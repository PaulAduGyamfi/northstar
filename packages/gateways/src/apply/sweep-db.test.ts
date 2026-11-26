import {
  applySchema,
  CLAIM_STALE_AFTER_MS,
  claimSubmission,
  type Db,
  decideApprovals,
  recordNeedsHuman,
  requestApproval,
  schema,
  transitionApplication,
} from "@northstar/db";
import { createTestDb, seedApplication, setGateClock } from "@northstar/db/testing";
import {
  ApplicationId,
  type ApplicationStatus,
  CandidateId,
  packageSha256,
  packageSubject,
  UNDO_WINDOW_MS,
} from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbSweepPorts } from "./ports.js";
import { applyMoveKey, sweepStaleClaims } from "./stale.js";
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

// A run closed its claim as outcome_unknown, then crashed before moving the application (NS-177).
// With `submitting`, it had moved the application to submitting first, as submitApplication does.
async function halfClosed(from: "awaiting_approval" | "submitting"): Promise<string> {
  const id = await deadRunClaim();
  if (from === "submitting") {
    const moved = await transitionApplication(db, {
      candidateId,
      applicationId: ApplicationId.parse(applicationId),
      from: "awaiting_approval",
      to: "submitting",
      actor: "agent:apply",
      reason: "",
      inputsSummary: "",
      links: [],
      idempotencyKey: applyMoveKey(applicationId, id, "submitting"),
    });
    if (!moved.ok) throw new Error(moved.error.kind);
  }
  const recorded = await recordNeedsHuman(db, candidateId, id, "outcome_unknown");
  if (!recorded.ok) throw new Error(recorded.error.kind);
  return id;
}

describe("sweepStaleClaims repairing a half-closed claim (NS-177)", () => {
  it("moves an application left at awaiting_approval to needs_human", async () => {
    const id = await halfClosed("awaiting_approval");
    const closed = await sweepStaleClaims(dbSweepPorts(db), candidateId);
    expect([closed, await applicationStatus()]).toEqual([[id], "needs_human"]);
  });

  it("moves an application left at submitting to needs_human", async () => {
    const id = await halfClosed("submitting");
    const closed = await sweepStaleClaims(dbSweepPorts(db), candidateId);
    expect([closed, await applicationStatus()]).toEqual([[id], "needs_human"]);
  });

  it("repairing twice writes each move's event once", async () => {
    await halfClosed("submitting");
    await sweepStaleClaims(dbSweepPorts(db), candidateId);
    const once = await eventTypes();
    const second = await sweepStaleClaims(dbSweepPorts(db), candidateId);
    expect([
      second,
      once.filter((t) => t === "application.needs_human").length,
      await eventTypes(),
    ]).toEqual([[], 1, once]);
  });

  it("reuses the gateway's move keys, so a move a repeat call already made isn't written again", async () => {
    const id = await halfClosed("awaiting_approval");
    await sweepStaleClaims(dbSweepPorts(db), candidateId);
    const keys = await db
      .select({ key: schema.domainEvent.idempotencyKey, type: schema.domainEvent.type })
      .from(schema.domainEvent);
    expect(
      keys
        .filter((k) => k.type.startsWith("application."))
        .map((k) => k.key)
        .sort(),
    ).toEqual(
      [
        applyMoveKey(applicationId, id, "needs_human"),
        applyMoveKey(applicationId, id, "submitting"),
      ].sort(),
    );
  });
});
