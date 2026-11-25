import { createHash, randomUUID } from "node:crypto";
import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadApplyLimits } from "./apply-config.js";
import { applySubmission, submissionProof } from "./apply-schema.js";
import {
  CLAIM_STALE_AFTER_MS,
  type ClaimInput,
  claimSubmission,
  DEFAULT_DAILY_CAP,
  DEFAULT_MIN_GAP_MS,
  listStaleClaims,
  recordNeedsHuman,
  recordSubmitted,
} from "./apply-write.js";
import { decideApprovals, requestApproval } from "./approval-write.js";
import type { Db } from "./db.js";
import { application, domainEvent, job } from "./schema.js";
import { createTestDb, seedApplication, sqlState } from "./test/pglite.js";

const RESTRICT_VIOLATION = "23001";
const UNIQUE_VIOLATION = "23505";
const NOW = new Date("2026-11-25T12:00:00Z");
const after = (ms: number) => new Date(NOW.getTime() + ms);

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let companyId: string;

async function setClock(at: Date): Promise<void> {
  await db.execute(sql`select set_config('northstar.gate_test_now', ${at.toISOString()}, false)`);
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "awaiting_approval");
  candidateId = CandidateId.parse(seeded.candidateId);
  companyId = seeded.companyId;
  await setClock(NOW);
});

afterEach(async () => {
  await close();
});

// A synthetic job, its application and an approved decision for it.
async function approvedApplication(): Promise<{ applicationId: string; decisionId: string }> {
  const [j] = await db
    .insert(job)
    .values({
      candidateId,
      companyId,
      title: "Engineer",
      url: `https://jobs.example.com/${randomUUID()}`,
    })
    .returning();
  if (!j) throw new Error("no job");
  const [a] = await db
    .insert(application)
    .values({ candidateId, jobId: j.id, status: "awaiting_approval" })
    .returning();
  if (!a) throw new Error("no application");
  const requested = await requestApproval(db, {
    candidateId,
    kind: "application_package",
    subject: `application_package:${randomUUID()}`,
    contentSha256: "c".repeat(64),
    facts: null,
    actor: "agent:apply",
    idempotencyKey: randomUUID(),
  });
  if (!requested.ok) throw new Error(requested.error.kind);
  const decided = await decideApprovals(db, {
    candidateId,
    requestIds: [requested.value.requestId],
    decision: "approve",
  });
  const outcome = decided.ok ? decided.value[0]?.result : undefined;
  if (!outcome?.ok) throw new Error("not approved");
  return { applicationId: a.id, decisionId: outcome.value.decisionId };
}

async function claimInput(overrides: Partial<ClaimInput> = {}): Promise<ClaimInput> {
  const { applicationId, decisionId } = await approvedApplication();
  return {
    candidateId,
    applicationId,
    decisionId,
    ats: "greenhouse",
    postingId: randomUUID(),
    ...overrides,
  };
}

async function claimOk(input: ClaimInput): Promise<string> {
  const result = await claimSubmission(db, input);
  if (!result.ok || !result.value.claimed) throw new Error("not claimed");
  return result.value.submission.submissionId;
}

const proof = {
  confirmationHtml: "<html><body>Thank you for applying.</body></html>",
  screenshotPng: new Uint8Array([137, 80, 78, 71]),
  fieldValues: { first_name: "Ada", question_1: "Yes" },
  resumeSha256: "a".repeat(64),
};

describe("claimSubmission", () => {
  it("claims an approved application as in progress", async () => {
    const result = await claimSubmission(db, await claimInput());
    expect(result.ok && result.value.claimed && result.value.submission.status).toBe("in_progress");
  });

  it("returns the first submission and claims nothing when called twice", async () => {
    const input = await claimInput();
    const first = await claimOk(input);
    const second = await claimSubmission(db, input);
    const rows = await db.select().from(applySubmission);
    expect([
      second.ok && !second.value.claimed && second.value.submission.submissionId,
      rows.length,
    ]).toEqual([first, 1]);
  });

  it("refuses a second application to the same requisition", async () => {
    const first = await claimInput({ postingId: "4001" });
    const id = await claimOk(first);
    await recordNeedsHuman(db, candidateId, id, "captcha");
    await setClock(after(10 * 60_000));
    const second = await claimSubmission(db, await claimInput({ postingId: "4001" }));
    expect(second).toEqual({ ok: false, error: { kind: "DuplicateRequisition" } });
  });

  it("refuses a second submission on an ATS while one is in progress", async () => {
    await claimOk(await claimInput());
    const second = await claimSubmission(db, await claimInput());
    expect(second).toEqual({ ok: false, error: { kind: "AtsBusy" } });
  });

  it("lets another ATS go while one is in progress", async () => {
    await claimOk(await claimInput());
    const other = await claimSubmission(db, await claimInput({ ats: "lever" }));
    expect(other.ok && other.value.claimed).toBe(true);
  });

  it("paces two submissions on the same ATS at least 90 seconds apart", async () => {
    const id = await claimOk(await claimInput());
    await recordSubmitted(db, candidateId, id, proof);
    await setClock(after(30_000));
    const second = await claimSubmission(db, await claimInput());
    expect(second).toEqual({ ok: false, error: { kind: "Paced", retryAt: after(90_000) } });
  });

  it("stops at the daily cap and says when it frees up", async () => {
    const limits = loadApplyLimits({ APPLY_DAILY_CAP: "2" });
    for (let i = 0; i < 2; i++) {
      await setClock(after(i * 60 * 60_000));
      const claimed = await claimSubmission(db, await claimInput(), limits);
      if (!claimed.ok || !claimed.value.claimed) throw new Error("not claimed");
      await recordSubmitted(db, candidateId, claimed.value.submission.submissionId, proof);
    }
    await setClock(after(3 * 60 * 60_000));
    const third = await claimSubmission(db, await claimInput(), limits);
    expect(third).toEqual({
      ok: false,
      error: { kind: "DailyCapReached", retryAt: after(24 * 60 * 60_000) },
    });
  });

  it("calls a repeated in-progress claim live before 15 minutes", async () => {
    const input = await claimInput();
    await claimOk(input);
    await setClock(after(CLAIM_STALE_AFTER_MS - 1_000));
    const again = await claimSubmission(db, input);
    expect(again.ok && !again.value.claimed && again.value.stale).toBe(false);
  });

  it("calls a repeated in-progress claim stale after 15 minutes", async () => {
    const input = await claimInput();
    await claimOk(input);
    await setClock(after(CLAIM_STALE_AFTER_MS));
    const again = await claimSubmission(db, input);
    expect(again.ok && !again.value.claimed && again.value.stale).toBe(true);
  });

  it("defaults to 25 a day and 90 seconds apart (APPLY-007)", () => {
    expect([DEFAULT_DAILY_CAP, DEFAULT_MIN_GAP_MS]).toEqual([25, 90_000]);
  });

  it("writes a claimed event with ids and the ATS only", async () => {
    const input = await claimInput();
    const id = await claimOk(input);
    const [event] = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.aggregate, `apply_submission:${id}`));
    expect([event?.type, event?.payload]).toEqual([
      "apply_submission.claimed",
      { applicationId: input.applicationId, decisionId: input.decisionId, ats: "greenhouse" },
    ]);
  });
});

describe("recordSubmitted", () => {
  it("stores the proof with its hashes and the database time", async () => {
    const id = await claimOk(await claimInput());
    await setClock(after(5_000));
    const result = await recordSubmitted(db, candidateId, id, proof);
    expect(
      result.ok && {
        status: result.value.submission.status,
        html: result.value.proof.confirmationHtml,
        png: [...result.value.proof.screenshotPng],
        fields: result.value.proof.fieldValues,
        resume: result.value.proof.resumeSha256,
        at: result.value.proof.capturedAt,
        htmlHash: result.value.proof.htmlSha256,
      },
    ).toEqual({
      status: "submitted",
      html: proof.confirmationHtml,
      png: [137, 80, 78, 71],
      fields: proof.fieldValues,
      resume: "a".repeat(64),
      at: after(5_000),
      htmlHash: createHash("sha256").update(proof.confirmationHtml).digest("hex"),
    });
  });

  it("returns the stored proof to a repeated claim", async () => {
    const input = await claimInput();
    const id = await claimOk(input);
    await recordSubmitted(db, candidateId, id, proof);
    const again = await claimSubmission(db, input);
    expect(again.ok && !again.value.claimed && again.value.proof?.confirmationHtml).toBe(
      proof.confirmationHtml,
    );
  });

  it("refuses to finish a submission twice", async () => {
    const id = await claimOk(await claimInput());
    await recordSubmitted(db, candidateId, id, proof);
    expect(await recordNeedsHuman(db, candidateId, id, "driver_error")).toEqual({
      ok: false,
      error: { kind: "NotInProgress" },
    });
  });
});

describe("database guards", () => {
  it("refuses changing a finished submission", async () => {
    const id = await claimOk(await claimInput());
    await recordSubmitted(db, candidateId, id, proof);
    const state = await sqlState(
      db
        .update(applySubmission)
        .set({ status: "needs_human", reason: "captcha" })
        .where(eq(applySubmission.id, id)),
    );
    expect(state).toBe(RESTRICT_VIOLATION);
  });

  it("refuses deleting a submission", async () => {
    const id = await claimOk(await claimInput());
    expect(await sqlState(db.delete(applySubmission).where(eq(applySubmission.id, id)))).toBe(
      RESTRICT_VIOLATION,
    );
  });

  it("refuses changing a stored proof", async () => {
    const id = await claimOk(await claimInput());
    await recordSubmitted(db, candidateId, id, proof);
    expect(
      await sqlState(db.update(submissionProof).set({ confirmationHtml: "<p>edited</p>" })),
    ).toBe(RESTRICT_VIOLATION);
  });

  it("refuses a second in-progress row on one ATS even when written directly", async () => {
    const a = await claimInput();
    await claimOk(a);
    const b = await claimInput();
    const state = await sqlState(
      db.insert(applySubmission).values({
        candidateId,
        applicationId: b.applicationId,
        decisionId: b.decisionId,
        ats: "greenhouse",
        requisitionKey: "greenhouse:other",
        idempotencyKey: `application:${b.applicationId}:submit`,
        status: "in_progress",
        startedAt: NOW,
      }),
    );
    expect(state).toBe(UNIQUE_VIOLATION);
  });
});

describe("listStaleClaims", () => {
  it("lists a claim in progress for 15 minutes", async () => {
    const id = await claimOk(await claimInput());
    await setClock(after(CLAIM_STALE_AFTER_MS));
    const stale = await listStaleClaims(db, candidateId);
    expect(stale.map((s) => [s.submissionId, s.status])).toEqual([[id, "in_progress"]]);
  });

  it("leaves out a claim in progress for less than 15 minutes", async () => {
    await claimOk(await claimInput());
    await setClock(after(CLAIM_STALE_AFTER_MS - 1_000));
    expect(await listStaleClaims(db, candidateId)).toEqual([]);
  });

  it("never lists a finished claim, however old", async () => {
    const id = await claimOk(await claimInput());
    await recordNeedsHuman(db, candidateId, id, "captcha");
    await setClock(after(2 * CLAIM_STALE_AFTER_MS));
    expect(await listStaleClaims(db, candidateId)).toEqual([]);
  });

  it("lists only the given candidate's claims", async () => {
    await claimOk(await claimInput());
    await setClock(after(CLAIM_STALE_AFTER_MS));
    const other = CandidateId.parse(randomUUID());
    expect(await listStaleClaims(db, other)).toEqual([]);
  });
});
