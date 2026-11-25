import { randomUUID } from "node:crypto";
import { CandidateId, type PackageFacts, type PolicyRule, UNDO_WINDOW_MS } from "@northstar/domain";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const EXCLUSION_VIOLATION = "23P01";
const NOW = new Date("2026-11-25T12:00:00Z");
const after = (ms: number) => new Date(NOW.getTime() + ms);

// Synthetic facts, rules and content only.
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
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});

afterAll(() => {
  trace.disable();
});

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

// Pins the Gate's database clock (northstar_gate_now()) for this test's session. Only tests do
// this; the Gate itself never takes a time from its caller.
async function setClock(at: Date): Promise<void> {
  await db.execute(sql`select set_config('northstar.gate_test_now', ${at.toISOString()}, false)`);
}

beforeEach(async () => {
  exporter.reset();
  ({ db, close } = await createTestDb());
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  candidateId = CandidateId.parse(c.id);
  await setClock(NOW);
});

afterEach(async () => {
  await close();
});

const subject = () => `application:${randomUUID()}`;

type RequestArgs = Parameters<typeof requestApproval>[1];

const requestArgs = (overrides: Partial<RequestArgs> = {}): RequestArgs => ({
  candidateId,
  kind: "email_reply",
  subject: subject(),
  contentSha256: HASH_A,
  facts: null,
  actor: "agent:inbox",
  idempotencyKey: randomUUID(),
  ...overrides,
});

const packageArgs = (overrides: Partial<RequestArgs> = {}): RequestArgs =>
  requestArgs({
    kind: "application_package",
    facts: goodFacts,
    actor: "agent:apply",
    ...overrides,
  });

// A request in the queue; by default an email reply (no facts).
async function request(overrides: Partial<RequestArgs> = {}): Promise<string> {
  const result = await requestApproval(db, requestArgs(overrides));
  if (!result.ok) throw new Error(result.error.kind);
  return result.value.requestId;
}

async function approve(requestIds: string[]) {
  const result = await decideApprovals(db, { candidateId, requestIds, decision: "approve" });
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

async function approveOne(requestId: string): Promise<string> {
  const [outcome] = await approve([requestId]);
  if (!outcome?.result.ok) throw new Error("not approved");
  return outcome.result.value.decisionId;
}

async function reject(requestId: string, reason = "Not a fit") {
  const result = await decideApprovals(db, {
    candidateId,
    requestIds: [requestId],
    decision: "reject",
    reason,
  });
  if (!result.ok || !result.value[0]?.result.ok) throw new Error("not rejected");
  return result.value[0].result.value.decisionId;
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
    await undoDecision(db, { candidateId, decisionId: await approveOne(await request()) });
    expect(await sqlState(db.update(approvalUndo).set({ undoneAt: NOW }).where(sql`true`))).toBe(
      RESTRICT_VIOLATION,
    );
    expect(await sqlState(db.delete(approvalUndo).where(sql`true`))).toBe(RESTRICT_VIOLATION);
  });

  it("refuses UPDATE and DELETE on approval_policy_set", async () => {
    await setApprovalPolicies(db, { candidateId, rules: [rule] });
    expect(
      await sqlState(db.update(approvalPolicySet).set({ createdAt: NOW }).where(sql`true`)),
    ).toBe(RESTRICT_VIOLATION);
    expect(await sqlState(db.delete(approvalPolicySet).where(sql`true`))).toBe(RESTRICT_VIOLATION);
  });
});

describe("the database guards", () => {
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
    expect(state).toBe(UNIQUE_VIOLATION);
  });

  it("stamps a decision with the database clock and a window equal to UNDO_WINDOW_MS", async () => {
    const requestId = await request();
    // A caller's times are ignored, however far off they are.
    await db.insert(approvalDecision).values({
      candidateId,
      requestId,
      decision: "approved",
      decidedBy: "user",
      decidedAt: new Date("2000-01-01T00:00:00Z"),
      effectiveAt: new Date("2000-01-01T00:00:00Z"),
    });
    const [row] = await db.select().from(approvalDecision);
    expect([row?.decidedAt, row?.effectiveAt]).toEqual([NOW, after(UNDO_WINDOW_MS)]);
  });

  it("refuses an undo written straight to the table once the database clock passes the window", async () => {
    const decisionId = await approveOne(await request());
    await setClock(after(UNDO_WINDOW_MS));
    // The caller claims an earlier time; the database clock decides.
    const state = await sqlState(
      db.insert(approvalUndo).values({ candidateId, decisionId, undoneAt: NOW }),
    );
    expect(state).toBe(CHECK_VIOLATION);
  });

  it("refuses a policy decision on anything but an application package", async () => {
    const requestId = await request({ kind: "outreach" });
    const [set] = await db
      .insert(approvalPolicySet)
      .values({ candidateId, rules: [rule], createdAt: NOW })
      .returning();
    const state = await sqlState(
      db.insert(approvalDecision).values({
        candidateId,
        requestId,
        decision: "approved",
        decidedBy: "policy",
        policySetId: set?.id,
        ruleName: rule.name,
        decidedAt: NOW,
        effectiveAt: NOW,
      }),
    );
    expect(state).toBe(CHECK_VIOLATION);
  });

  it("refuses a second open request for one subject written straight to the table", async () => {
    const subj = subject();
    await request({ subject: subj });
    const state = await sqlState(
      db.insert(approvalRequest).values({
        candidateId,
        kind: "email_reply",
        subject: subj,
        contentSha256: HASH_A,
        actor: "system",
        idempotencyKey: "direct",
        requestedAt: NOW,
      }),
    );
    expect(state).toBe(EXCLUSION_VIOLATION);
  });
});

describe("requestApproval", () => {
  it("stores one request and one event when asked twice with the same key", async () => {
    const args = requestArgs({ idempotencyKey: "email:draft-1:approval" });
    const first = await requestApproval(db, args);
    const second = await requestApproval(db, args);
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

  it("returns the policy's decision when an auto-approved request is replayed", async () => {
    await setApprovalPolicies(db, { candidateId, rules: [rule] });
    const args = packageArgs();
    const first = await requestApproval(db, args);
    const second = await requestApproval(db, args);
    if (!first.ok || !second.ok) throw new Error("request failed");
    expect(second.value.decision).toEqual(first.value.decision);
  });

  it("refuses a key reused for a different subject or different content", async () => {
    await request({ idempotencyKey: "k1", subject: subject() });
    expect(await requestApproval(db, requestArgs({ idempotencyKey: "k1" }))).toEqual({
      ok: false,
      error: { kind: "IdempotencyKeyReused" },
    });
    const subj = subject();
    await request({ idempotencyKey: "k2", subject: subj });
    expect(
      await requestApproval(
        db,
        requestArgs({ idempotencyKey: "k2", subject: subj, contentSha256: HASH_B }),
      ),
    ).toEqual({ ok: false, error: { kind: "IdempotencyKeyReused" } });
  });

  it("refuses a malformed subject, a malformed hash and facts on a kind that has none", async () => {
    expect(await requestApproval(db, requestArgs({ subject: "application:not-a-uuid" }))).toEqual({
      ok: false,
      error: { kind: "InvalidRequest", fields: ["subject"] },
    });
    expect(await requestApproval(db, requestArgs({ contentSha256: "abc" }))).toEqual({
      ok: false,
      error: { kind: "InvalidRequest", fields: ["contentSha256"] },
    });
    expect(await requestApproval(db, requestArgs({ facts: goodFacts }))).toEqual({
      ok: false,
      error: { kind: "InvalidRequest", fields: ["facts"] },
    });
  });

  it("waits for Paul when no policy set exists", async () => {
    const result = await requestApproval(db, packageArgs());
    if (!result.ok) throw new Error(result.error.kind);
    expect([result.value.outcome, result.value.decision]).toEqual([
      { auto: false, why: "no_policies" },
      null,
    ]);
    expect(await listPendingApprovals(db, candidateId)).toHaveLength(1);
  });

  it("auto-approves a package that matches a rule, citing the set and rule, with an undo window", async () => {
    const set = await setApprovalPolicies(db, { candidateId, rules: [rule] });
    if (!set.ok) throw new Error("policy set refused");
    const result = await requestApproval(db, packageArgs());
    if (!result.ok || !result.value.decision) throw new Error("not auto-approved");
    expect(result.value.decision).toMatchObject({
      decision: "approved",
      decidedBy: "policy",
      ruleName: "strong fit",
      decidedAt: NOW,
      effectiveAt: after(UNDO_WINDOW_MS),
    });
    const [row] = await db.select().from(approvalDecision);
    expect(row?.policySetId).toBe(set.value.policySetId);
    expect(await listPendingApprovals(db, candidateId)).toEqual([]);
  });

  it("never auto-approves an email reply, even with a policy set", async () => {
    await setApprovalPolicies(db, { candidateId, rules: [rule] });
    const result = await requestApproval(db, requestArgs());
    if (!result.ok) throw new Error(result.error.kind);
    expect([result.value.outcome, result.value.decision]).toEqual([
      { auto: false, why: "never_auto" },
      null,
    ]);
  });

  it("treats a stored policy set that no longer parses as no rules", async () => {
    // Written by hand, missing minFit: it must not pass the fit condition by accident.
    const { minFit: _dropped, ...broken } = rule;
    await db
      .insert(approvalPolicySet)
      .values({ candidateId, rules: [broken as PolicyRule], createdAt: NOW });
    const result = await requestApproval(db, packageArgs());
    if (!result.ok) throw new Error(result.error.kind);
    expect([result.value.outcome, result.value.decision]).toEqual([
      { auto: false, why: "no_policies" },
      null,
    ]);
    expect(await readApprovalPolicies(db, candidateId)).toEqual([]);
  });
});

describe("one open request per subject", () => {
  it("refuses a new request for a subject that is still pending", async () => {
    const subj = subject();
    await request({ subject: subj });
    expect(await requestApproval(db, requestArgs({ subject: subj }))).toEqual({
      ok: false,
      error: { kind: "SubjectAlreadyRequested" },
    });
  });

  it("refuses a new request for a subject that is approved", async () => {
    const subj = subject();
    await approveOne(await request({ subject: subj }));
    expect(await requestApproval(db, requestArgs({ subject: subj }))).toEqual({
      ok: false,
      error: { kind: "SubjectAlreadyRequested" },
    });
  });

  it("can't get around Paul's undo of an auto-approval by asking again", async () => {
    await setApprovalPolicies(db, { candidateId, rules: [rule] });
    const subj = subject();
    const first = await requestApproval(db, packageArgs({ subject: subj }));
    if (!first.ok || !first.value.decision) throw new Error("not auto-approved");
    await undoDecision(db, { candidateId, decisionId: first.value.decision.decisionId });
    expect(await requestApproval(db, packageArgs({ subject: subj }))).toEqual({
      ok: false,
      error: { kind: "SubjectAlreadyRequested" },
    });
  });

  it("lets a rejected subject be requested again, and then it always waits for Paul", async () => {
    await setApprovalPolicies(db, { candidateId, rules: [rule] });
    const subj = subject();
    const first = await requestApproval(db, packageArgs({ subject: subj }));
    if (!first.ok || !first.value.decision) throw new Error("not auto-approved");
    await undoDecision(db, { candidateId, decisionId: first.value.decision.decisionId });
    await reject(first.value.requestId);
    const again = await requestApproval(db, packageArgs({ subject: subj, contentSha256: HASH_B }));
    if (!again.ok) throw new Error(again.error.kind);
    expect([again.value.outcome, again.value.decision]).toEqual([
      { auto: false, why: "declined_before" },
      null,
    ]);
  });
});

describe("setApprovalPolicies", () => {
  it("refuses a rule for another kind and stores nothing", async () => {
    const result = await setApprovalPolicies(db, {
      candidateId,
      rules: [{ ...rule, kind: "outreach" }],
    });
    expect(result).toEqual({ ok: false, error: { kind: "InvalidPolicySet", fields: ["0.kind"] } });
    expect(await db.select().from(approvalPolicySet)).toEqual([]);
  });

  it("uses the newest set; an empty set turns auto-approval off", async () => {
    await setApprovalPolicies(db, { candidateId, rules: [rule] });
    expect(await readApprovalPolicies(db, candidateId)).toEqual([rule]);
    await setApprovalPolicies(db, { candidateId, rules: [] });
    expect(await readApprovalPolicies(db, candidateId)).toEqual([]);
    expect(await db.select().from(approvalPolicySet)).toHaveLength(2);
  });
});

describe("listPendingApprovals", () => {
  it("lists every kind in one queue, oldest first, and filters by kind", async () => {
    const answer = await request({ kind: "answer" });
    await setClock(after(1000));
    const reply = await request();
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
      await decideApprovals(db, { candidateId, requestIds: [id], decision: "reject", reason: " " }),
    ).toEqual({ ok: false, error: { kind: "ReasonRequired" } });
    expect(await db.select().from(approvalDecision)).toEqual([]);
  });

  it("stores the reason of a rejection but never puts it in an event", async () => {
    await reject(await request(), "Tone is too formal for this company");
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
    await setClock(after(UNDO_WINDOW_MS - 1));
    expect(await undoDecision(db, { candidateId, decisionId })).toEqual({
      ok: true,
      value: { requestId: id },
    });
    expect((await listPendingApprovals(db, candidateId)).map((p) => p.requestId)).toEqual([id]);
  });

  it("lets a request be decided again after an undo", async () => {
    const id = await request();
    await undoDecision(db, { candidateId, decisionId: await approveOne(id) });
    const [again] = await approve([id]);
    expect(again?.result.ok).toBe(true);
  });

  it("refuses an undo once the window has closed", async () => {
    const decisionId = await approveOne(await request());
    await setClock(after(UNDO_WINDOW_MS));
    expect(await undoDecision(db, { candidateId, decisionId })).toEqual({
      ok: false,
      error: { kind: "UndoWindowClosed" },
    });
  });

  it("refuses to undo the same decision twice", async () => {
    const decisionId = await approveOne(await request());
    await undoDecision(db, { candidateId, decisionId });
    expect(await undoDecision(db, { candidateId, decisionId })).toEqual({
      ok: false,
      error: { kind: "AlreadyUndone" },
    });
  });
});

describe("verifyApproval", () => {
  const verify = (
    decisionId: string,
    subj: string,
    overrides: Partial<Parameters<typeof verifyApproval>[1]> = {},
  ) =>
    verifyApproval(db, {
      candidateId,
      decisionId,
      kind: "email_reply",
      subject: subj,
      contentSha256: HASH_A,
      ...overrides,
    });

  it("accepts a live approval of the same kind, subject and content after its undo window", async () => {
    const subj = subject();
    const id = await request({ subject: subj });
    const decisionId = await approveOne(id);
    await setClock(after(UNDO_WINDOW_MS));
    expect(await verify(decisionId, subj)).toEqual({
      ok: true,
      value: { decisionId, requestId: id, decidedBy: "user", effectiveAt: after(UNDO_WINDOW_MS) },
    });
  });

  it("refuses an id that names no decision", async () => {
    expect(await verify(randomUUID(), subject())).toEqual({
      ok: false,
      error: { kind: "NotFound" },
    });
    expect(await verify("", subject())).toEqual({ ok: false, error: { kind: "NotFound" } });
  });

  it("refuses another candidate's decision", async () => {
    const subj = subject();
    const decisionId = await approveOne(await request({ subject: subj }));
    await setClock(after(UNDO_WINDOW_MS));
    const [other] = await db.insert(candidate).values({ displayName: "Other" }).returning();
    if (!other) throw new Error("no candidate");
    expect(await verify(decisionId, subj, { candidateId: CandidateId.parse(other.id) })).toEqual({
      ok: false,
      error: { kind: "NotFound" },
    });
  });

  it("refuses an approval still inside its undo window by the database clock", async () => {
    const subj = subject();
    const decisionId = await approveOne(await request({ subject: subj }));
    await setClock(after(UNDO_WINDOW_MS - 1));
    expect(await verify(decisionId, subj)).toEqual({
      ok: false,
      error: { kind: "UndoWindowOpen", effectiveAt: after(UNDO_WINDOW_MS) },
    });
  });

  it("refuses a rejection", async () => {
    const subj = subject();
    const decisionId = await reject(await request({ subject: subj }));
    await setClock(after(UNDO_WINDOW_MS));
    expect(await verify(decisionId, subj)).toEqual({ ok: false, error: { kind: "Rejected" } });
  });

  it("refuses an undone approval", async () => {
    const subj = subject();
    const decisionId = await approveOne(await request({ subject: subj }));
    await undoDecision(db, { candidateId, decisionId });
    await setClock(after(UNDO_WINDOW_MS));
    expect(await verify(decisionId, subj)).toEqual({ ok: false, error: { kind: "Undone" } });
  });

  it("refuses an approval used for a different subject or kind", async () => {
    const subj = subject();
    const decisionId = await approveOne(await request({ subject: subj }));
    await setClock(after(UNDO_WINDOW_MS));
    expect(await verify(decisionId, subject())).toEqual({
      ok: false,
      error: { kind: "SubjectMismatch" },
    });
    expect(await verify(decisionId, subj, { kind: "outreach" })).toEqual({
      ok: false,
      error: { kind: "SubjectMismatch" },
    });
  });

  it("refuses when the content about to be sent is not what was approved", async () => {
    const subj = subject();
    const decisionId = await approveOne(await request({ subject: subj }));
    await setClock(after(UNDO_WINDOW_MS));
    expect(await verify(decisionId, subj, { contentSha256: HASH_B })).toEqual({
      ok: false,
      error: { kind: "ContentChanged" },
    });
  });

  it("accepts a policy decision as a policyDecisionId after its window", async () => {
    await setApprovalPolicies(db, { candidateId, rules: [rule] });
    const subj = subject();
    const result = await requestApproval(db, packageArgs({ subject: subj }));
    const decisionId = result.ok ? (result.value.decision?.decisionId ?? "") : "";
    await setClock(after(UNDO_WINDOW_MS));
    const verified = await verify(decisionId, subj, { kind: "application_package" });
    expect(verified.ok && verified.value.decidedBy).toBe("policy");
  });
});

describe("approval events", () => {
  it("record request, decision and undo with ids and kinds only", async () => {
    const subj = subject();
    const id = await request({ subject: subj });
    const decisionId = await approveOne(id);
    await undoDecision(db, { candidateId, decisionId });
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

  it("record a policy set and a policy's decision with counts and the rule name", async () => {
    const set = await setApprovalPolicies(db, { candidateId, rules: [rule] });
    if (!set.ok) throw new Error("policy set refused");
    const result = await requestApproval(db, packageArgs());
    if (!result.ok || !result.value.decision) throw new Error("not auto-approved");
    const rows = await events();
    expect(rows.map((e) => [e.type, e.actor])).toEqual([
      ["approval.policies_set", "user"],
      ["approval.requested", "agent:apply"],
      ["approval.decided", "system"],
    ]);
    expect(rows[0]?.payload).toEqual({ rules: 1, version: set.value.version });
    expect(rows[2]?.payload).toEqual({
      decisionId: result.value.decision.decisionId,
      decision: "approved",
      decidedBy: "policy",
      ruleName: "strong fit",
      effectiveAt: after(UNDO_WINDOW_MS).toISOString(),
    });
  });
});

describe("approval spans", () => {
  it("name each step with its kind and outcome, and carry no reject reason", async () => {
    const subj = subject();
    const id = await request({ subject: subj });
    const decisionId = await reject(id, "Tone is too formal for this company");
    await undoDecision(db, { candidateId, decisionId });
    await verifyApproval(db, {
      candidateId,
      decisionId,
      kind: "email_reply",
      subject: subj,
      contentSha256: HASH_A,
    });
    const spans = exporter
      .getFinishedSpans()
      .filter((s) => s.name.startsWith("approval."))
      .map((s) => [
        s.name,
        s.attributes["northstar.approval.kind"],
        s.attributes["northstar.approval.outcome"],
      ]);
    expect(spans).toEqual([
      ["approval.request", "email_reply", "ok"],
      ["approval.decide", "email_reply", "ok"],
      ["approval.undo", "email_reply", "ok"],
      ["approval.verify", "email_reply", "Undone"],
    ]);
    const attributes = JSON.stringify(exporter.getFinishedSpans().map((s) => s.attributes));
    expect(attributes).not.toContain("Tone is too formal");
  });
});
