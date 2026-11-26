import { randomUUID } from "node:crypto";
import { CandidateId, type PackageFacts, type PolicyRule, UNDO_WINDOW_MS } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approvalPolicySet, approvalWithdrawal } from "./approval-schema.js";
import {
  decideApprovals,
  listPendingApprovals,
  requestApproval,
  requestOfDecision,
  setApprovalPolicies,
  undoDecision,
  verifyApproval,
  withdrawApproval,
} from "./approval-write.js";
import type { Db } from "./db.js";
import { candidate, domainEvent } from "./schema.js";
import { createTestDb, sqlState } from "./test/pglite.js";

// The withdraw record (NS-140, APR-004). Synthetic subjects, facts and content hashes only.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";
const NOW = new Date("2026-11-25T12:00:00Z");
const PAST_UNDO = new Date(NOW.getTime() + UNDO_WINDOW_MS + 1000);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const goodFacts: PackageFacts = {
  fit: 92,
  adapter: "known",
  formSeenBefore: true,
  answers: [{ source: "bank_exact", freeTextWords: 30 }],
};
const rule: PolicyRule = {
  name: "strong fit",
  kind: "application_package",
  minFit: 85,
  allowHighConfidenceAnswers: false,
  maxFreeTextWords: 100,
};

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

async function setClock(at: Date): Promise<void> {
  await db.execute(sql`select set_config('northstar.gate_test_now', ${at.toISOString()}, false)`);
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  candidateId = CandidateId.parse(c.id);
  await setClock(NOW);
});

afterEach(async () => {
  await close();
});

async function request(subject: string, over: { kind?: "application_package" } = {}) {
  const r = await requestApproval(db, {
    candidateId,
    kind: over.kind ?? "email_reply",
    subject,
    contentSha256: HASH_A,
    facts: over.kind ? goodFacts : null,
    actor: over.kind ? "agent:apply" : "agent:inbox",
    idempotencyKey: randomUUID(),
  });
  if (!r.ok) throw new Error(r.error.kind);
  return r.value;
}

async function approve(requestId: string): Promise<string> {
  const d = await decideApprovals(db, {
    candidateId,
    requestIds: [requestId],
    decision: "approve",
  });
  const outcome = d.ok ? d.value[0]?.result : undefined;
  if (!outcome?.ok) throw new Error("not approved");
  return outcome.value.decisionId;
}

const verify = (decisionId: string, subject: string, kind = "email_reply" as const) =>
  verifyApproval(db, { candidateId, decisionId, kind, subject, contentSha256: HASH_A });

describe("withdrawApproval by Paul", () => {
  it("takes a pending request out of the queue and lets its subject be asked again", async () => {
    const subject = `email:${randomUUID()}`;
    const first = await request(subject);
    expect(
      await withdrawApproval(db, { candidateId, requestId: first.requestId, by: "user" }),
    ).toEqual({
      ok: true,
      value: { withdrawalId: expect.any(String), requestId: first.requestId, decisionId: null },
    });
    expect(await listPendingApprovals(db, candidateId)).toEqual([]);
    const again = await request(subject);
    expect((await listPendingApprovals(db, candidateId)).map((p) => p.requestId)).toEqual([
      again.requestId,
    ]);
  });

  it("closes an approval, so verifyApproval refuses it as Withdrawn", async () => {
    const subject = `email:${randomUUID()}`;
    const { requestId } = await request(subject);
    const decisionId = await approve(requestId);
    await setClock(PAST_UNDO);
    expect((await verify(decisionId, subject)).ok).toBe(true);
    await withdrawApproval(db, { candidateId, requestId, by: "user" });
    expect(await verify(decisionId, subject)).toEqual({ ok: false, error: { kind: "Withdrawn" } });
  });

  it("makes a new request for the subject wait for Paul, even when a rule matches", async () => {
    await setApprovalPolicies(db, { candidateId, rules: [rule] });
    const subject = `application:${randomUUID()}`;
    const first = await request(subject, { kind: "application_package" });
    expect(first.decision?.decidedBy).toBe("policy");
    await withdrawApproval(db, { candidateId, requestId: first.requestId, by: "user" });
    const again = await request(subject, { kind: "application_package" });
    expect([again.decision, again.outcome]).toEqual([
      null,
      { auto: false, why: "declined_before" },
    ]);
  });

  it("refuses to withdraw a rejected request, or one twice", async () => {
    const rejected = await request(`email:${randomUUID()}`);
    await decideApprovals(db, {
      candidateId,
      requestIds: [rejected.requestId],
      decision: "reject",
      reason: "Not this one",
    });
    const pending = await request(`email:${randomUUID()}`);
    await withdrawApproval(db, { candidateId, requestId: pending.requestId, by: "user" });
    expect([
      await withdrawApproval(db, { candidateId, requestId: rejected.requestId, by: "user" }),
      await withdrawApproval(db, { candidateId, requestId: pending.requestId, by: "user" }),
      await withdrawApproval(db, { candidateId, requestId: randomUUID(), by: "user" }),
    ]).toEqual([
      { ok: false, error: { kind: "AlreadyClosed" } },
      { ok: false, error: { kind: "AlreadyClosed" } },
      { ok: false, error: { kind: "NotFound" } },
    ]);
  });

  it("refuses a decision on a withdrawn request, and an undo of its decision", async () => {
    const pending = await request(`email:${randomUUID()}`);
    await withdrawApproval(db, { candidateId, requestId: pending.requestId, by: "user" });
    const decided = await decideApprovals(db, {
      candidateId,
      requestIds: [pending.requestId],
      decision: "approve",
    });
    const approved = await request(`email:${randomUUID()}`);
    const decisionId = await approve(approved.requestId);
    await withdrawApproval(db, { candidateId, requestId: approved.requestId, by: "user" });
    expect([
      decided.ok && decided.value[0]?.result,
      await undoDecision(db, { candidateId, decisionId }),
    ]).toEqual([
      { ok: false, error: { kind: "Withdrawn" } },
      { ok: false, error: { kind: "Withdrawn" } },
    ]);
  });

  it("writes one approval.withdrawn event with ids and codes only", async () => {
    const { requestId } = await request(`email:${randomUUID()}`);
    const decisionId = await approve(requestId);
    const done = await withdrawApproval(db, { candidateId, requestId, by: "user" });
    const [event] = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.type, "approval.withdrawn"));
    expect([event?.actor, event?.aggregate, event?.payload]).toEqual([
      "user",
      `approval:${requestId}`,
      {
        withdrawalId: done.ok ? done.value.withdrawalId : "",
        decisionId,
        withdrawnBy: "user",
        reason: "paul",
      },
    ]);
  });
});

describe("withdrawApproval by a gateway", () => {
  it("refuses unless the content really changed and the request is approved", async () => {
    const approved = await request(`email:${randomUUID()}`);
    await approve(approved.requestId);
    const pending = await request(`email:${randomUUID()}`);
    await setClock(PAST_UNDO);
    expect([
      await withdrawApproval(db, {
        candidateId,
        requestId: approved.requestId,
        by: "gateway",
        newContentSha256: HASH_A,
      }),
      await withdrawApproval(db, {
        candidateId,
        requestId: pending.requestId,
        by: "gateway",
        newContentSha256: HASH_B,
      }),
    ]).toEqual([
      { ok: false, error: { kind: "ContentUnchanged" } },
      { ok: false, error: { kind: "NotApproved" } },
    ]);
  });

  it("refuses to close an approval still inside Paul's undo window", async () => {
    const { requestId } = await request(`email:${randomUUID()}`);
    const decisionId = await approve(requestId);
    const result = await withdrawApproval(db, {
      candidateId,
      requestId,
      by: "gateway",
      newContentSha256: HASH_B,
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: "UndoWindowOpen", effectiveAt: new Date(NOW.getTime() + UNDO_WINDOW_MS) },
    });
    // Paul can still undo it.
    expect((await undoDecision(db, { candidateId, decisionId })).ok).toBe(true);
  });

  it("refuses a gateway row inside the undo window even written directly", async () => {
    const { requestId } = await request(`email:${randomUUID()}`);
    await approve(requestId);
    expect(
      await sqlState(
        db.insert(approvalWithdrawal).values({
          candidateId,
          requestId,
          withdrawnBy: "gateway",
          reason: "content_changed",
          withdrawnAt: NOW,
        }),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it("closes an approval whose content changed, and a policy may approve the new request", async () => {
    await setApprovalPolicies(db, { candidateId, rules: [rule] });
    const subject = `application:${randomUUID()}`;
    const first = await request(subject, { kind: "application_package" });
    await setClock(PAST_UNDO);
    const withdrawn = await withdrawApproval(db, {
      candidateId,
      requestId: first.requestId,
      by: "gateway",
      newContentSha256: HASH_B,
    });
    const again = await request(subject, { kind: "application_package" });
    expect([withdrawn.ok, again.decision?.decidedBy]).toEqual([true, "policy"]);
  });
});

describe("requestOfDecision", () => {
  it("gives the request a decision belongs to, so a gateway can withdraw it", async () => {
    const { requestId } = await request(`email:${randomUUID()}`);
    const decisionId = await approve(requestId);
    expect(await requestOfDecision(db, { candidateId, decisionId })).toEqual({
      ok: true,
      value: { requestId },
    });
  });

  it("finds nothing for an unknown or malformed decision id", async () => {
    expect([
      await requestOfDecision(db, { candidateId, decisionId: randomUUID() }),
      await requestOfDecision(db, { candidateId, decisionId: "not-a-uuid" }),
    ]).toEqual([
      { ok: false, error: { kind: "NotFound" } },
      { ok: false, error: { kind: "NotFound" } },
    ]);
  });

  it("finds nothing for another candidate's decision", async () => {
    const { requestId } = await request(`email:${randomUUID()}`);
    const decisionId = await approve(requestId);
    const [other] = await db.insert(candidate).values({ displayName: "Other" }).returning();
    if (!other) throw new Error("no candidate");
    expect(
      await requestOfDecision(db, { candidateId: CandidateId.parse(other.id), decisionId }),
    ).toEqual({ ok: false, error: { kind: "NotFound" } });
  });
});

describe("approval_withdrawal in the database", () => {
  it("refuses update and delete, and stamps its time from the Gate's clock", async () => {
    const { requestId } = await request(`email:${randomUUID()}`);
    await withdrawApproval(db, { candidateId, requestId, by: "user" });
    const [row] = await db.select().from(approvalWithdrawal);
    expect(row?.withdrawnAt).toEqual(NOW);
    expect(
      await sqlState(
        db
          .update(approvalWithdrawal)
          .set({ reason: "content_changed" })
          .where(eq(approvalWithdrawal.requestId, requestId)),
      ),
    ).toBe(RESTRICT_VIOLATION);
    expect(
      await sqlState(
        db.delete(approvalWithdrawal).where(eq(approvalWithdrawal.requestId, requestId)),
      ),
    ).toBe(RESTRICT_VIOLATION);
  });

  it("refuses a gateway row on a pending request, and a withdrawal of a rejected one, even written directly", async () => {
    const pending = await request(`email:${randomUUID()}`);
    const rejected = await request(`email:${randomUUID()}`);
    await decideApprovals(db, {
      candidateId,
      requestIds: [rejected.requestId],
      decision: "reject",
      reason: "No",
    });
    const row = (requestId: string, by: "user" | "gateway") =>
      db.insert(approvalWithdrawal).values({
        candidateId,
        requestId,
        withdrawnBy: by,
        reason: by === "user" ? "paul" : "content_changed",
        withdrawnAt: NOW,
      });
    expect([
      await sqlState(row(pending.requestId, "gateway")),
      await sqlState(row(rejected.requestId, "user")),
    ]).toEqual([CHECK_VIOLATION, CHECK_VIOLATION]);
  });

  it("refuses truncate", async () => {
    expect(await sqlState(db.execute(sql`truncate approval_withdrawal`))).toBe(RESTRICT_VIOLATION);
  });

  it("refuses an undo of a withdrawn request's decision even written directly", async () => {
    const { requestId } = await request(`email:${randomUUID()}`);
    const decisionId = await approve(requestId);
    await withdrawApproval(db, { candidateId, requestId, by: "user" });
    expect(
      await sqlState(
        db.execute(sql`insert into approval_undo (candidate_id, decision_id, undone_at)
          values (${candidateId}, ${decisionId}, now())`),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it("lets Paul undo a rejection once the newer request for its subject was withdrawn", async () => {
    const subject = `email:${randomUUID()}`;
    const first = await request(subject);
    const rejected = await decideApprovals(db, {
      candidateId,
      requestIds: [first.requestId],
      decision: "reject",
      reason: "Not yet",
    });
    const rejection = rejected.ok ? rejected.value[0]?.result : undefined;
    if (!rejection?.ok) throw new Error("not rejected");
    const second = await request(subject);
    await withdrawApproval(db, { candidateId, requestId: second.requestId, by: "user" });
    expect(await undoDecision(db, { candidateId, decisionId: rejection.value.decisionId })).toEqual(
      {
        ok: true,
        value: { requestId: first.requestId },
      },
    );
  });

  it("refuses a policy decision on a subject Paul withdrew, even written directly", async () => {
    await setApprovalPolicies(db, { candidateId, rules: [rule] });
    const subject = `application:${randomUUID()}`;
    const first = await request(subject, { kind: "application_package" });
    await withdrawApproval(db, { candidateId, requestId: first.requestId, by: "user" });
    const again = await request(subject, { kind: "application_package" });
    const [policySet] = await db.select({ id: approvalPolicySet.id }).from(approvalPolicySet);
    expect(
      await sqlState(
        db.execute(sql`insert into approval_decision (candidate_id, request_id, decision, decided_by, policy_set_id, rule_name, decided_at, effective_at)
          values (${candidateId}, ${again.requestId}, 'approved', 'policy', ${policySet?.id}, 'strong fit', now(), now())`),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it("refuses a decision on a withdrawn request even written directly", async () => {
    const pending = await request(`email:${randomUUID()}`);
    await withdrawApproval(db, { candidateId, requestId: pending.requestId, by: "user" });
    expect(
      await sqlState(
        db.execute(sql`insert into approval_decision (candidate_id, request_id, decision, decided_by, decided_at, effective_at)
          values (${candidateId}, ${pending.requestId}, 'approved', 'user', now(), now())`),
      ),
    ).toBe(CHECK_VIOLATION);
  });
});
