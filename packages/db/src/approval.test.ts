import { randomUUID } from "node:crypto";
import { CandidateId, type PackageFacts, type PolicyRule, UNDO_WINDOW_MS } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approvalDecision,
  approvalPolicySet,
  approvalRequest,
  approvalUndo,
} from "./approval-schema.js";
import {
  decideApprovals,
  listPendingApprovals,
  readApprovalPolicies,
  requestApproval,
  setApprovalPolicies,
  undoDecision,
  verifyApproval,
} from "./approval-write.js";
import type { Db } from "./db.js";
import { candidate, domainEvent } from "./schema.js";
import { createTestDb, sqlState } from "./test/pglite.js";

const RESTRICT_VIOLATION = "23001";
const NOW = new Date("2026-11-25T12:00:00Z");
const after = (ms: number) => new Date(NOW.getTime() + ms);

// Synthetic facts and rules only.
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

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  candidateId = CandidateId.parse(c.id);
});

afterEach(async () => {
  await close();
});

const subject = () => `application:${randomUUID()}`;

// A request in the queue; facts default to none (an email reply).
async function request(
  overrides: Partial<Parameters<typeof requestApproval>[1]> = {},
): Promise<string> {
  const result = await requestApproval(db, {
    candidateId,
    kind: "email_reply",
    subject: subject(),
    facts: null,
    actor: "agent:inbox",
    idempotencyKey: randomUUID(),
    now: NOW,
    ...overrides,
  });
  if (!result.ok) throw new Error(result.error.kind);
  return result.value.requestId;
}

async function approve(requestIds: string[], now = NOW) {
  const result = await decideApprovals(db, { candidateId, requestIds, decision: "approve", now });
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

async function approveOne(requestId: string, now = NOW): Promise<string> {
  const [outcome] = await approve([requestId], now);
  if (!outcome?.result.ok) throw new Error("not approved");
  return outcome.result.value.decisionId;
}

const events = () =>
  db
    .select()
    .from(domainEvent)
    .where(eq(domainEvent.candidateId, candidateId))
    .orderBy(domainEvent.position);

describe("approval records are append-only", () => {
  it("refuses UPDATE and DELETE on approval_request", async () => {
    const id = await request();
    expect(
      await sqlState(db.update(approvalRequest).set({ actor: "system" }).where(sql`true`)),
    ).toBe(RESTRICT_VIOLATION);
    expect(await sqlState(db.delete(approvalRequest).where(eq(approvalRequest.id, id)))).toBe(
      RESTRICT_VIOLATION,
    );
  });

  it("refuses UPDATE and DELETE on approval_decision", async () => {
    await approveOne(await request());
    expect(
      await sqlState(db.update(approvalDecision).set({ decision: "rejected" }).where(sql`true`)),
    ).toBe(RESTRICT_VIOLATION);
    expect(await sqlState(db.delete(approvalDecision).where(sql`true`))).toBe(RESTRICT_VIOLATION);
  });

  it("refuses UPDATE and DELETE on approval_undo", async () => {
    await undoDecision(db, {
      candidateId,
      decisionId: await approveOne(await request()),
      now: NOW,
    });
    expect(await sqlState(db.update(approvalUndo).set({ undoneAt: NOW }).where(sql`true`))).toBe(
      RESTRICT_VIOLATION,
    );
    expect(await sqlState(db.delete(approvalUndo).where(sql`true`))).toBe(RESTRICT_VIOLATION);
  });

  it("refuses UPDATE and DELETE on approval_policy_set", async () => {
    await setApprovalPolicies(db, { candidateId, rules: [rule], now: NOW });
    expect(
      await sqlState(db.update(approvalPolicySet).set({ createdAt: NOW }).where(sql`true`)),
    ).toBe(RESTRICT_VIOLATION);
    expect(await sqlState(db.delete(approvalPolicySet).where(sql`true`))).toBe(RESTRICT_VIOLATION);
  });

  it("refuses a second live decision written straight to the table", async () => {
    const requestId = await request();
    await approveOne(requestId);
    const state = await sqlState(
      db.insert(approvalDecision).values({
        candidateId,
        requestId,
        decision: "approved",
        decidedBy: "user",
        decidedAt: NOW,
        effectiveAt: NOW,
      }),
    );
    expect(state).toBe("23505");
  });

  it("refuses an undo written straight to the table after the window", async () => {
    const decisionId = await approveOne(await request());
    const state = await sqlState(
      db.insert(approvalUndo).values({ candidateId, decisionId, undoneAt: after(UNDO_WINDOW_MS) }),
    );
    expect(state).toBe("23514");
  });
});

describe("requestApproval", () => {
  it("stores one request and one event when asked twice with the same key", async () => {
    const input = {
      candidateId,
      kind: "email_reply" as const,
      subject: subject(),
      facts: null,
      actor: "agent:inbox",
      idempotencyKey: "email:draft-1:approval",
      now: NOW,
    };
    const first = await requestApproval(db, input);
    const second = await requestApproval(db, input);
    if (!first.ok || !second.ok) throw new Error("request failed");
    expect(second.value).toEqual({
      requestId: first.value.requestId,
      outcome: null,
      decision: null,
      replayed: true,
    });
    expect(await db.select().from(approvalRequest)).toHaveLength(1);
    expect((await events()).map((e) => e.type)).toEqual(["approval.requested"]);
  });

  it("refuses a key reused for a different subject", async () => {
    await request({ idempotencyKey: "k1" });
    const result = await requestApproval(db, {
      candidateId,
      kind: "email_reply",
      subject: subject(),
      facts: null,
      actor: "agent:inbox",
      idempotencyKey: "k1",
      now: NOW,
    });
    expect(result).toEqual({ ok: false, error: { kind: "IdempotencyKeyReused" } });
  });

  it("refuses a malformed subject and facts on a kind that has none", async () => {
    const bad = await requestApproval(db, {
      candidateId,
      kind: "email_reply",
      subject: "application:not-a-uuid",
      facts: null,
      actor: "agent:inbox",
      idempotencyKey: "k2",
      now: NOW,
    });
    expect(bad).toEqual({ ok: false, error: { kind: "InvalidRequest", fields: ["subject"] } });
    const facts = await requestApproval(db, {
      candidateId,
      kind: "email_reply",
      subject: subject(),
      facts: goodFacts,
      actor: "agent:inbox",
      idempotencyKey: "k3",
      now: NOW,
    });
    expect(facts).toEqual({ ok: false, error: { kind: "InvalidRequest", fields: ["facts"] } });
  });

  it("waits for Paul when no policy set exists", async () => {
    const result = await requestApproval(db, {
      candidateId,
      kind: "application_package",
      subject: subject(),
      facts: goodFacts,
      actor: "agent:apply",
      idempotencyKey: "k4",
      now: NOW,
    });
    if (!result.ok) throw new Error(result.error.kind);
    expect(result.value.outcome).toEqual({ auto: false, why: "no_policies" });
    expect(result.value.decision).toBeNull();
    expect(await listPendingApprovals(db, candidateId)).toHaveLength(1);
  });

  it("auto-approves a package that matches a rule, citing the set and rule, with an undo window", async () => {
    const set = await setApprovalPolicies(db, { candidateId, rules: [rule], now: NOW });
    if (!set.ok) throw new Error("policy set refused");
    const result = await requestApproval(db, {
      candidateId,
      kind: "application_package",
      subject: subject(),
      facts: goodFacts,
      actor: "agent:apply",
      idempotencyKey: "k5",
      now: NOW,
    });
    if (!result.ok || !result.value.decision) throw new Error("not auto-approved");
    expect(result.value.decision).toMatchObject({
      decision: "approved",
      decidedBy: "policy",
      ruleName: "strong fit",
      effectiveAt: after(UNDO_WINDOW_MS),
    });
    const [row] = await db.select().from(approvalDecision);
    expect(row?.policySetId).toBe(set.value.policySetId);
    expect(await listPendingApprovals(db, candidateId)).toEqual([]);
  });

  it("never auto-approves an email reply, even with a policy set", async () => {
    await setApprovalPolicies(db, { candidateId, rules: [rule], now: NOW });
    const result = await requestApproval(db, {
      candidateId,
      kind: "email_reply",
      subject: subject(),
      facts: null,
      actor: "agent:inbox",
      idempotencyKey: "k6",
      now: NOW,
    });
    if (!result.ok) throw new Error(result.error.kind);
    expect(result.value.outcome).toEqual({ auto: false, why: "never_auto" });
    expect(result.value.decision).toBeNull();
  });
});

describe("setApprovalPolicies", () => {
  it("refuses a rule for another kind and stores nothing", async () => {
    const result = await setApprovalPolicies(db, {
      candidateId,
      rules: [{ ...rule, kind: "outreach" }],
      now: NOW,
    });
    expect(result).toEqual({ ok: false, error: { kind: "InvalidPolicySet", fields: ["0.kind"] } });
    expect(await db.select().from(approvalPolicySet)).toEqual([]);
  });

  it("uses the newest set; an empty set turns auto-approval off", async () => {
    await setApprovalPolicies(db, { candidateId, rules: [rule], now: NOW });
    expect(await readApprovalPolicies(db, candidateId)).toEqual([rule]);
    await setApprovalPolicies(db, { candidateId, rules: [], now: NOW });
    expect(await readApprovalPolicies(db, candidateId)).toEqual([]);
    expect(await db.select().from(approvalPolicySet)).toHaveLength(2);
  });
});

describe("listPendingApprovals", () => {
  it("lists every kind in one queue, oldest first, and filters by kind", async () => {
    const reply = await request({ now: after(1000) });
    const answer = await request({ kind: "answer", now: NOW });
    expect((await listPendingApprovals(db, candidateId)).map((p) => p.requestId)).toEqual([
      answer,
      reply,
    ]);
    expect((await listPendingApprovals(db, candidateId, "answer")).map((p) => p.requestId)).toEqual(
      [answer],
    );
  });
});

describe("decideApprovals", () => {
  it("approves a batch and returns one outcome per request", async () => {
    const ids = [await request(), await request(), await request()];
    const outcomes = await approve(ids);
    expect(outcomes.map((o) => [o.requestId, o.result.ok])).toEqual(ids.map((id) => [id, true]));
    expect(await listPendingApprovals(db, candidateId)).toEqual([]);
  });

  it("reports an unknown id in a batch as its own NotFound while the others succeed", async () => {
    const real = await request();
    const outcomes = await approve([randomUUID(), "not-a-uuid", real]);
    expect(outcomes.map((o) => (o.result.ok ? "ok" : o.result.error.kind))).toEqual([
      "NotFound",
      "NotFound",
      "ok",
    ]);
  });

  it("refuses to decide a request that already has a live decision", async () => {
    const id = await request();
    await approveOne(id);
    const [again] = await approve([id]);
    expect(again?.result).toEqual({ ok: false, error: { kind: "AlreadyDecided" } });
  });

  it("refuses a rejection without a reason", async () => {
    const id = await request();
    expect(
      await decideApprovals(db, {
        candidateId,
        requestIds: [id],
        decision: "reject",
        reason: "  ",
        now: NOW,
      }),
    ).toEqual({ ok: false, error: { kind: "ReasonRequired" } });
    expect(await db.select().from(approvalDecision)).toEqual([]);
  });

  it("stores the reason of a rejection but never puts it in an event", async () => {
    const id = await request();
    await decideApprovals(db, {
      candidateId,
      requestIds: [id],
      decision: "reject",
      reason: "Tone is too formal for this company",
      now: NOW,
    });
    const [row] = await db.select().from(approvalDecision);
    expect(row?.reason).toBe("Tone is too formal for this company");
    // position is a bigint, which JSON can't hold; every text field is checked.
    const text = JSON.stringify(
      (await events()).map(({ reason, inputsSummary, payload }) => ({
        reason,
        inputsSummary,
        payload,
      })),
    );
    expect(text).not.toContain("Tone is too formal");
  });

  it("does not let a request belonging to another candidate be decided", async () => {
    const id = await request();
    const [other] = await db.insert(candidate).values({ displayName: "Other" }).returning();
    if (!other) throw new Error("no candidate");
    const result = await decideApprovals(db, {
      candidateId: CandidateId.parse(other.id),
      requestIds: [id],
      decision: "approve",
      now: NOW,
    });
    expect(result.ok && result.value[0]?.result).toEqual({
      ok: false,
      error: { kind: "NotFound" },
    });
  });
});

describe("undoDecision", () => {
  it("puts the request back in the queue inside the undo window", async () => {
    const id = await request();
    const decisionId = await approveOne(id);
    const undone = await undoDecision(db, {
      candidateId,
      decisionId,
      now: after(UNDO_WINDOW_MS - 1),
    });
    expect(undone).toEqual({ ok: true, value: { requestId: id } });
    expect((await listPendingApprovals(db, candidateId)).map((p) => p.requestId)).toEqual([id]);
  });

  it("lets a request be decided again after an undo", async () => {
    const id = await request();
    await undoDecision(db, { candidateId, decisionId: await approveOne(id), now: NOW });
    const [again] = await approve([id]);
    expect(again?.result.ok).toBe(true);
  });

  it("refuses an undo once the window has closed", async () => {
    const decisionId = await approveOne(await request());
    expect(await undoDecision(db, { candidateId, decisionId, now: after(UNDO_WINDOW_MS) })).toEqual(
      { ok: false, error: { kind: "UndoWindowClosed" } },
    );
  });

  it("refuses to undo the same decision twice", async () => {
    const decisionId = await approveOne(await request());
    await undoDecision(db, { candidateId, decisionId, now: NOW });
    expect(await undoDecision(db, { candidateId, decisionId, now: NOW })).toEqual({
      ok: false,
      error: { kind: "AlreadyUndone" },
    });
  });
});

describe("verifyApproval", () => {
  const verify = (decisionId: string, subj: string, now: Date, kind = "email_reply" as const) =>
    verifyApproval(db, { candidateId, decisionId, kind, subject: subj, now });

  it("accepts a live approval of the same kind and subject after its undo window", async () => {
    const subj = subject();
    const id = await request({ subject: subj });
    const decisionId = await approveOne(id);
    expect(await verify(decisionId, subj, after(UNDO_WINDOW_MS))).toEqual({
      ok: true,
      value: { decisionId, requestId: id, decidedBy: "user", effectiveAt: after(UNDO_WINDOW_MS) },
    });
  });

  it("refuses an id that names no decision", async () => {
    expect(await verify(randomUUID(), subject(), NOW)).toEqual({
      ok: false,
      error: { kind: "NotFound" },
    });
    expect(await verify("", subject(), NOW)).toEqual({ ok: false, error: { kind: "NotFound" } });
  });

  it("refuses an approval still inside its undo window", async () => {
    const subj = subject();
    const decisionId = await approveOne(await request({ subject: subj }));
    expect(await verify(decisionId, subj, after(UNDO_WINDOW_MS - 1))).toEqual({
      ok: false,
      error: { kind: "UndoWindowOpen", effectiveAt: after(UNDO_WINDOW_MS) },
    });
  });

  it("refuses a rejection", async () => {
    const subj = subject();
    const id = await request({ subject: subj });
    const result = await decideApprovals(db, {
      candidateId,
      requestIds: [id],
      decision: "reject",
      reason: "Not now",
      now: NOW,
    });
    const decisionId =
      result.ok && result.value[0]?.result.ok ? result.value[0].result.value.decisionId : "";
    expect(await verify(decisionId, subj, after(UNDO_WINDOW_MS))).toEqual({
      ok: false,
      error: { kind: "Rejected" },
    });
  });

  it("refuses an undone approval", async () => {
    const subj = subject();
    const decisionId = await approveOne(await request({ subject: subj }));
    await undoDecision(db, { candidateId, decisionId, now: NOW });
    expect(await verify(decisionId, subj, after(UNDO_WINDOW_MS))).toEqual({
      ok: false,
      error: { kind: "Undone" },
    });
  });

  it("refuses an approval used for a different subject or kind", async () => {
    const subj = subject();
    const decisionId = await approveOne(await request({ subject: subj }));
    expect(await verify(decisionId, subject(), after(UNDO_WINDOW_MS))).toEqual({
      ok: false,
      error: { kind: "SubjectMismatch" },
    });
    expect(
      await verifyApproval(db, {
        candidateId,
        decisionId,
        kind: "outreach",
        subject: subj,
        now: after(UNDO_WINDOW_MS),
      }),
    ).toEqual({ ok: false, error: { kind: "SubjectMismatch" } });
  });

  it("accepts a policy decision as a policyDecisionId after its window", async () => {
    await setApprovalPolicies(db, { candidateId, rules: [rule], now: NOW });
    const subj = subject();
    const result = await requestApproval(db, {
      candidateId,
      kind: "application_package",
      subject: subj,
      facts: goodFacts,
      actor: "agent:apply",
      idempotencyKey: "k7",
      now: NOW,
    });
    const decisionId = result.ok ? (result.value.decision?.decisionId ?? "") : "";
    const verified = await verifyApproval(db, {
      candidateId,
      decisionId,
      kind: "application_package",
      subject: subj,
      now: after(UNDO_WINDOW_MS),
    });
    expect(verified.ok && verified.value.decidedBy).toBe("policy");
  });
});

describe("approval events", () => {
  it("record request, decision and undo with ids and kinds only", async () => {
    const subj = subject();
    const id = await request({ subject: subj });
    const decisionId = await approveOne(id);
    await undoDecision(db, { candidateId, decisionId, now: NOW });
    const rows = await events();
    expect(rows.map((e) => [e.type, e.aggregate, e.actor])).toEqual([
      ["approval.requested", `approval:${id}`, "agent:inbox"],
      ["approval.decided", `approval:${id}`, "user"],
      ["approval.undone", `approval:${id}`, "user"],
    ]);
    expect(rows[0]?.payload).toEqual({ kind: "email_reply", subject: subj });
    expect(rows[1]?.payload).toEqual({
      decisionId,
      decision: "approved",
      decidedBy: "user",
      ruleName: null,
      effectiveAt: after(UNDO_WINDOW_MS).toISOString(),
    });
  });
});
