import { randomUUID } from "node:crypto";
import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimSubmission, recordNeedsHuman } from "./apply-write.js";
import { decideApprovals, requestApproval } from "./approval-write.js";
import type { Db } from "./db.js";
import { applyHandoff, applyHandoffDone } from "./handoff-schema.js";
import { listOpenHandoffs, recordHandoffPrefill, resolveHandoff } from "./handoff-write.js";
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

  it.each([
    ["isn't https", "javascript:alert(1)"],
    ["is over 2048 characters", `https://boards.greenhouse.io/x/jobs/1?q=${"a".repeat(3000)}`],
  ])("still records needs_human, with no handoff, for a link that %s", async (_why, bad) => {
    const { submissionId } = await inProgress();
    const r = await recordNeedsHuman(db, candidateId, submissionId, "captcha", bad);
    expect(r.ok).toBe(true);
    expect(await listOpenHandoffs(db, candidateId)).toEqual([]);
  });

  it.each([
    ["an upper-case scheme and host", "HTTPS://Boards.Greenhouse.io/globex/jobs/123", APPLY_URL],
    ["a space", `${APPLY_URL}?a=b c`, `${APPLY_URL}?a=b%20c`],
  ])("stores a link with %s in its normal form", async (_what, given, stored) => {
    const { submissionId } = await inProgress();
    await recordNeedsHuman(db, candidateId, submissionId, "captcha", given);
    const [h] = await listOpenHandoffs(db, candidateId);
    expect(h?.applyUrl).toBe(stored);
  });

  it("the database refuses a link that isn't https", async () => {
    const { submissionId } = await inProgress();
    const state = await sqlState(
      db
        .insert(applyHandoff)
        .values({ candidateId, submissionId, applyUrl: "javascript:alert(1)", createdAt: NOW }),
    );
    expect(state).toBe(CHECK_VIOLATION);
  });
});

describe("resolveHandoff", () => {
  it("closes a handoff with Paul's outcome, so it is no longer open", async () => {
    const { submissionId, applicationId } = await inProgress();
    await recordNeedsHuman(db, candidateId, submissionId, "captcha", APPLY_URL);
    const [h] = await listOpenHandoffs(db, candidateId);
    if (!h) throw new Error("no handoff");
    // The gateway moves the application to needs_human right after recordNeedsHuman.
    await db
      .update(application)
      .set({ status: "needs_human" })
      .where(eq(application.id, applicationId));
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

  it("refuses 'submitted' once the application has left needs_human, and stores nothing", async () => {
    const { submissionId, applicationId } = await inProgress();
    await recordNeedsHuman(db, candidateId, submissionId, "captcha", APPLY_URL);
    const [h] = await listOpenHandoffs(db, candidateId);
    if (!h) throw new Error("no handoff");
    await db
      .update(application)
      .set({ status: "withdrawn" })
      .where(eq(application.id, applicationId));
    const r = await resolveHandoff(db, {
      candidateId,
      handoffId: h.handoffId,
      outcome: "submitted",
    });
    expect(r).toEqual({ ok: false, error: { kind: "NotNeedsHuman" } });
    expect(await listOpenHandoffs(db, candidateId)).toHaveLength(1);
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
    expect(await sqlState(db.execute(sql`truncate apply_handoff cascade`))).toBe(
      RESTRICT_VIOLATION,
    );
  });

  it("an outcome can't be updated, deleted or truncated", async () => {
    const { submissionId } = await inProgress();
    await recordNeedsHuman(db, candidateId, submissionId, "captcha", APPLY_URL);
    const [h] = await listOpenHandoffs(db, candidateId);
    if (!h) throw new Error("no handoff");
    await resolveHandoff(db, { candidateId, handoffId: h.handoffId, outcome: "gave_up" });
    expect(await sqlState(db.update(applyHandoffDone).set({ outcome: "submitted" }))).toBe(
      RESTRICT_VIOLATION,
    );
    expect(await sqlState(db.delete(applyHandoffDone))).toBe(RESTRICT_VIOLATION);
    expect(await sqlState(db.execute(sql`truncate apply_handoff_done`))).toBe(RESTRICT_VIOLATION);
  });
});

// NS-192 slice 3: the extension was handed a package to pre-fill.
describe("recordHandoffPrefill", () => {
  // A grant key's shape (16 hex characters), built rather than written out, so secret scanners
  // don't read a test value as a key.
  const SAMPLE_GRANT = "a1".repeat(8);
  // An open handoff for a synthetic submission stopped at a CAPTCHA.
  async function openOne(): Promise<{ handoffId: string; applicationId: string }> {
    const { submissionId, applicationId } = await inProgress();
    await recordNeedsHuman(db, candidateId, submissionId, "captcha", APPLY_URL);
    const [h] = await listOpenHandoffs(db, candidateId);
    if (!h) throw new Error("no handoff");
    return { handoffId: h.handoffId, applicationId };
  }
  const prefilledEvents = () =>
    db
      .select({
        actor: domainEvent.actor,
        reason: domainEvent.reason,
        payload: domainEvent.payload,
      })
      .from(domainEvent)
      .where(eq(domainEvent.type, "handoff.prefilled"));

  it("writes handoff.prefilled by Paul with ids, the ATS and a count, and no value", async () => {
    const { handoffId, applicationId } = await openOne();
    const r = await recordHandoffPrefill(db, {
      candidateId,
      handoffId,
      applicationId,
      ats: "greenhouse",
      fieldCount: 3,
      grantKey: SAMPLE_GRANT,
    });
    expect(r).toEqual({ ok: true, value: { recorded: true } });
    expect(await prefilledEvents()).toEqual([
      {
        actor: "user",
        reason: "Pre-filled a Greenhouse form for you to finish",
        payload: { applicationId, ats: "greenhouse", fieldCount: 3 },
      },
    ]);
  });

  it("stores one event for the same grant, and another for a new grant", async () => {
    const { handoffId, applicationId } = await openOne();
    const record = (grantKey: string) =>
      recordHandoffPrefill(db, {
        candidateId,
        handoffId,
        applicationId,
        ats: "greenhouse",
        fieldCount: 3,
        grantKey,
      });
    await record(SAMPLE_GRANT);
    await record(SAMPLE_GRANT);
    await record("b2".repeat(8));
    expect(await prefilledEvents()).toHaveLength(2);
  });

  it("refuses another candidate's handoff as not found, and stores nothing", async () => {
    const { handoffId, applicationId } = await openOne();
    const r = await recordHandoffPrefill(db, {
      candidateId: CandidateId.parse(randomUUID()),
      handoffId,
      applicationId,
      ats: "greenhouse",
      fieldCount: 3,
      grantKey: SAMPLE_GRANT,
    });
    expect([r, await prefilledEvents()]).toEqual([{ ok: false, error: { kind: "NotFound" } }, []]);
  });

  it("refuses an application that isn't the handoff's own, and stores nothing", async () => {
    const { handoffId } = await openOne();
    const r = await recordHandoffPrefill(db, {
      candidateId,
      handoffId,
      applicationId: randomUUID(),
      ats: "greenhouse",
      fieldCount: 3,
      grantKey: SAMPLE_GRANT,
    });
    expect([r, await prefilledEvents()]).toEqual([{ ok: false, error: { kind: "NotFound" } }, []]);
  });

  it.each([-1, 2.5, 201])("refuses a field count of %s, and stores nothing", async (fieldCount) => {
    const { handoffId, applicationId } = await openOne();
    const r = await recordHandoffPrefill(db, {
      candidateId,
      handoffId,
      applicationId,
      ats: "greenhouse",
      fieldCount,
      grantKey: SAMPLE_GRANT,
    });
    expect([r, await prefilledEvents()]).toEqual([
      { ok: false, error: { kind: "InvalidInput" } },
      [],
    ]);
  });

  it("refuses a grant key that isn't 16 hex characters, and stores nothing", async () => {
    const { handoffId, applicationId } = await openOne();
    const r = await recordHandoffPrefill(db, {
      candidateId,
      handoffId,
      applicationId,
      ats: "greenhouse",
      fieldCount: 3,
      grantKey: "not-a-grant-key!",
    });
    expect([r, await prefilledEvents()]).toEqual([
      { ok: false, error: { kind: "InvalidInput" } },
      [],
    ]);
  });
});
