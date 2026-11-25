import { randomUUID } from "node:crypto";
import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimSubmission, recordNeedsHuman } from "./apply-write.js";
import { decideApprovals, requestApproval } from "./approval-write.js";
import type { Db } from "./db.js";
import { applyHandoff, applyHandoffDone } from "./handoff-schema.js";
import { listOpenHandoffs, resolveHandoff } from "./handoff-write.js";
import { application, domainEvent, job } from "./schema.js";
import { createTestDb, seedApplication, sqlState } from "./test/pglite.js";

// Human handoffs (NS-121) on the real write paths, PGlite. Synthetic jobs and example.com links.
const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";
const NOW = new Date("2026-11-25T12:00:00Z");
const APPLY_URL = "https://boards.greenhouse.io/globex/jobs/123";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let companyId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "awaiting_approval");
  candidateId = CandidateId.parse(seeded.candidateId);
  companyId = seeded.companyId;
  await db.execute(sql`select set_config('northstar.gate_test_now', ${NOW.toISOString()}, false)`);
});

afterEach(async () => {
  await close();
});

// A claimed, in-progress submission for a synthetic approved application.
async function inProgress(): Promise<{ submissionId: string; applicationId: string }> {
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
  const claimed = await claimSubmission(db, {
    candidateId,
    applicationId: a.id,
    decisionId: outcome.value.decisionId,
    ats: "greenhouse",
    postingId: randomUUID(),
  });
  if (!claimed.ok || !("claimed" in claimed.value)) throw new Error("not claimed");
  return { submissionId: claimed.value.submission.submissionId, applicationId: a.id };
}

describe("recordNeedsHuman with an apply URL", () => {
  it("stores a handoff for a challenge, in the same step as needs_human", async () => {
    const { submissionId, applicationId } = await inProgress();
    const r = await recordNeedsHuman(db, candidateId, submissionId, "captcha", APPLY_URL);
    expect(r.ok).toBe(true);
    const open = await listOpenHandoffs(db, candidateId);
    expect(open.map((h) => [h.submissionId, h.applicationId, h.ats, h.reason, h.applyUrl])).toEqual(
      [[submissionId, applicationId, "greenhouse", "captcha", APPLY_URL]],
    );
  });

  it("writes a handoff.opened event that carries no URL", async () => {
    const { submissionId } = await inProgress();
    await recordNeedsHuman(db, candidateId, submissionId, "login", APPLY_URL);
    const events = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.type, "handoff.opened"));
    expect(events.map((e) => e.payload)).toEqual([
      expect.objectContaining({ submissionId, ats: "greenhouse", reason: "login" }),
    ]);
    expect(JSON.stringify(events.map((e) => [e.payload, e.reason]))).not.toContain("greenhouse.io");
  });

  it("stores no handoff for a reason Paul's hands can't finish", async () => {
    const { submissionId } = await inProgress();
    await recordNeedsHuman(db, candidateId, submissionId, "form_changed", APPLY_URL);
    expect(await listOpenHandoffs(db, candidateId)).toEqual([]);
  });

  it("stores no handoff without an apply URL (a stale claim swept closed)", async () => {
    const { submissionId } = await inProgress();
    await recordNeedsHuman(db, candidateId, submissionId, "captcha");
    expect(await listOpenHandoffs(db, candidateId)).toEqual([]);
  });

  it("refuses an apply URL that isn't https, and stores nothing", async () => {
    const { submissionId } = await inProgress();
    const state = await sqlState(
      recordNeedsHuman(db, candidateId, submissionId, "captcha", "javascript:alert(1)"),
    );
    expect(state).toBe(CHECK_VIOLATION);
    expect(await listOpenHandoffs(db, candidateId)).toEqual([]);
  });
});

describe("resolveHandoff", () => {
  it("closes a handoff with Paul's outcome, so it is no longer open", async () => {
    const { submissionId, applicationId } = await inProgress();
    await recordNeedsHuman(db, candidateId, submissionId, "captcha", APPLY_URL);
    const [h] = await listOpenHandoffs(db, candidateId);
    if (!h) throw new Error("no handoff");
    const r = await resolveHandoff(db, {
      candidateId,
      handoffId: h.handoffId,
      outcome: "submitted",
    });
    expect(r).toEqual({
      ok: true,
      value: { applicationId, outcome: "submitted", replayed: false },
    });
    expect(await listOpenHandoffs(db, candidateId)).toEqual([]);
  });

  it("resolving twice keeps the first outcome and writes nothing more", async () => {
    const { submissionId } = await inProgress();
    await recordNeedsHuman(db, candidateId, submissionId, "mfa", APPLY_URL);
    const [h] = await listOpenHandoffs(db, candidateId);
    if (!h) throw new Error("no handoff");
    await resolveHandoff(db, { candidateId, handoffId: h.handoffId, outcome: "gave_up" });
    const again = await resolveHandoff(db, {
      candidateId,
      handoffId: h.handoffId,
      outcome: "submitted",
    });
    expect(again.ok && again.value).toMatchObject({ outcome: "gave_up", replayed: true });
    expect(await db.select().from(applyHandoffDone)).toHaveLength(1);
    const resolved = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.type, "handoff.resolved"));
    expect(resolved).toHaveLength(1);
  });

  it("refuses another candidate's handoff as not found", async () => {
    const { submissionId } = await inProgress();
    await recordNeedsHuman(db, candidateId, submissionId, "captcha", APPLY_URL);
    const [h] = await listOpenHandoffs(db, candidateId);
    if (!h) throw new Error("no handoff");
    const other = CandidateId.parse(randomUUID());
    const r = await resolveHandoff(db, {
      candidateId: other,
      handoffId: h.handoffId,
      outcome: "gave_up",
    });
    expect(r).toEqual({ ok: false, error: { kind: "NotFound" } });
  });
});

describe("the handoff tables", () => {
  it("can't be updated or deleted", async () => {
    const { submissionId } = await inProgress();
    await recordNeedsHuman(db, candidateId, submissionId, "captcha", APPLY_URL);
    expect(
      await sqlState(db.update(applyHandoff).set({ applyUrl: "https://example.com/other" })),
    ).toBe(RESTRICT_VIOLATION);
    expect(await sqlState(db.delete(applyHandoff))).toBe(RESTRICT_VIOLATION);
  });
});
