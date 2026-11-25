import { randomUUID } from "node:crypto";
import {
  ApprovalKind,
  type CandidateId,
  err,
  evaluatePolicies,
  type InvalidPolicySet,
  ok,
  PackageFacts,
  type PolicyOutcome,
  type PolicyRule,
  parseDomainEvent,
  parsePolicySet,
  type Result,
  UNDO_WINDOW_MS,
} from "@northstar/domain";
import { isSpanContextValid, SpanStatusCode, trace } from "@opentelemetry/api";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  approvalDecision,
  approvalPolicySet,
  approvalRequest,
  approvalUndo,
} from "./approval-schema.js";
import type { Db } from "./db.js";
import { domainEvent } from "./schema.js";

// The Approval Gate (NS-119, ADR-0002, ADR-0017): requests, Paul's policies, decisions, undo and
// the check every gateway runs before it acts. The only writer of the approval_* tables. Events
// and spans carry ids, kinds and counts only: never a reject reason or any draft text.

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type DecisionView = {
  decisionId: string;
  requestId: string;
  decision: "approved" | "rejected";
  decidedBy: "user" | "policy";
  ruleName: string | null;
  decidedAt: Date;
  effectiveAt: Date;
};

export type PendingApproval = {
  requestId: string;
  kind: ApprovalKind;
  subject: string;
  requestedAt: Date;
};

export type InvalidRequest = { kind: "InvalidRequest"; fields: string[] };
export type IdempotencyKeyReused = { kind: "IdempotencyKeyReused" };
export type ReasonRequired = { kind: "ReasonRequired" };
export type NotFound = { kind: "NotFound" };
export type AlreadyDecided = { kind: "AlreadyDecided" };
export type AlreadyUndone = { kind: "AlreadyUndone" };
export type UndoWindowClosed = { kind: "UndoWindowClosed" };
export type Rejected = { kind: "Rejected" };
export type Undone = { kind: "Undone" };
export type UndoWindowOpen = { kind: "UndoWindowOpen"; effectiveAt: Date };
export type SubjectMismatch = { kind: "SubjectMismatch" };

export type DecideError = NotFound | AlreadyDecided;
export type UndoError = NotFound | AlreadyUndone | UndoWindowClosed;
export type VerifyError = NotFound | Rejected | Undone | UndoWindowOpen | SubjectMismatch;

const Subject = z
  .string()
  .regex(/^[a-z_]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const Uuid = z.uuid();
const RequestInput = z.object({
  kind: ApprovalKind,
  subject: Subject,
  // Only application packages carry facts; every other kind has none to give a policy.
  facts: PackageFacts.nullable(),
  actor: z.string().regex(/^(agent:[a-z0-9-]+|system)$/),
  idempotencyKey: z.string().min(1).max(200),
});

const tracer = () => trace.getTracer("@northstar/db");

// Runs fn inside a span; an expected refusal marks the span with its kind, a throw with
// "DatabaseError" only (never row data).
async function inSpan<R extends { ok: true } | { ok: false; error: { kind: string } }>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: () => Promise<R>,
): Promise<R> {
  return tracer().startActiveSpan(name, async (span) => {
    span.setAttributes(attributes);
    try {
      const result = await fn();
      span.setAttribute("northstar.approval.outcome", result.ok ? "ok" : result.error.kind);
      if (!result.ok) span.setStatus({ code: SpanStatusCode.ERROR, message: result.error.kind });
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "DatabaseError" });
      throw error;
    } finally {
      span.end();
    }
  });
}

// The current span's trace id, or null when tracing is off (an all-zero context).
function traceId(): string | null {
  const context = trace.getActiveSpan()?.spanContext();
  return context && isSpanContextValid(context) ? context.traceId : null;
}

async function appendEvent(
  tx: Tx,
  e: {
    candidateId: CandidateId;
    requestId: string;
    type: string;
    actor: string;
    reason: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    at: Date;
  },
): Promise<void> {
  const parsed = parseDomainEvent({
    id: randomUUID(),
    candidateId: e.candidateId,
    // Every approval event is keyed by its request, so the feed shows one request's history.
    aggregate: `approval:${e.requestId}`,
    type: e.type,
    actor: e.actor,
    reason: e.reason,
    inputsSummary: "",
    payload: e.payload,
    links: [],
    traceId: traceId(),
    idempotencyKey: e.idempotencyKey,
    occurredAt: e.at,
  });
  // Every field here is built by this module, so a bad event is a bug, not an input error.
  if (!parsed.ok) throw new Error(`invalid approval event: ${parsed.error.fields.join(", ")}`);
  await tx.insert(domainEvent).values(parsed.value);
}

const toDecisionView = (r: typeof approvalDecision.$inferSelect): DecisionView => ({
  decisionId: r.id,
  requestId: r.requestId,
  decision: r.decision as DecisionView["decision"],
  decidedBy: r.decidedBy as DecisionView["decidedBy"],
  ruleName: r.ruleName,
  decidedAt: r.decidedAt,
  effectiveAt: r.effectiveAt,
});

// The decision on a request that hasn't been undone, if any.
async function liveDecision(tx: Tx, requestId: string): Promise<DecisionView | null> {
  const [row] = await tx
    .select()
    .from(approvalDecision)
    .where(
      and(
        eq(approvalDecision.requestId, requestId),
        sql`not exists (select 1 from ${approvalUndo} where ${approvalUndo.decisionId} = ${approvalDecision.id})`,
      ),
    );
  return row ? toDecisionView(row) : null;
}

// The policy set in force: the newest one for this candidate, or null if Paul never set one.
async function currentPolicySet(
  tx: Tx,
  candidateId: CandidateId,
): Promise<{ id: string; rules: PolicyRule[] } | null> {
  const [row] = await tx
    .select({ id: approvalPolicySet.id, rules: approvalPolicySet.rules })
    .from(approvalPolicySet)
    .where(eq(approvalPolicySet.candidateId, candidateId))
    .orderBy(desc(approvalPolicySet.version))
    .limit(1);
  return row ?? null;
}

async function insertDecision(
  tx: Tx,
  values: typeof approvalDecision.$inferInsert,
  candidateId: CandidateId,
  actor: string,
): Promise<DecisionView> {
  const [row] = await tx.insert(approvalDecision).values(values).returning();
  if (!row) throw new Error("approval_decision insert returned no row");
  const view = toDecisionView(row);
  await appendEvent(tx, {
    candidateId,
    requestId: view.requestId,
    type: "approval.decided",
    actor,
    reason:
      view.decidedBy === "policy"
        ? "Auto-approved by policy; it can be undone until it takes effect"
        : `Paul ${view.decision} it`,
    payload: {
      decisionId: view.decisionId,
      decision: view.decision,
      decidedBy: view.decidedBy,
      ruleName: view.ruleName,
      effectiveAt: view.effectiveAt.toISOString(),
    },
    idempotencyKey: `approval_decision:${view.decisionId}`,
    at: view.decidedAt,
  });
  return view;
}

export type RequestResult = {
  requestId: string;
  // Why it was or wasn't auto-approved; null on a replay (the first call already decided).
  outcome: PolicyOutcome | null;
  // The policy's decision when one auto-approved it, else null (it waits for Paul).
  decision: DecisionView | null;
  replayed: boolean;
};

// Puts something in Paul's queue (APR-001) and runs his policies on it (ADR-0002 item 2). The
// same idempotency key twice returns the first request and writes nothing.
export async function requestApproval(
  db: Db,
  input: {
    candidateId: CandidateId;
    kind: ApprovalKind;
    subject: string;
    facts: PackageFacts | null;
    actor: string;
    idempotencyKey: string;
    now: Date;
  },
): Promise<Result<RequestResult, InvalidRequest | IdempotencyKeyReused>> {
  return inSpan("approval.request", { "northstar.approval.kind": input.kind }, async () => {
    const parsed = RequestInput.safeParse(input);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
      return err({ kind: "InvalidRequest", fields });
    }
    const req = parsed.data;
    if (req.kind !== "application_package" && req.facts !== null) {
      return err({ kind: "InvalidRequest", fields: ["facts"] });
    }
    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(approvalRequest)
        .where(
          and(
            eq(approvalRequest.candidateId, input.candidateId),
            eq(approvalRequest.idempotencyKey, req.idempotencyKey),
          ),
        );
      if (existing) {
        if (existing.kind !== req.kind || existing.subject !== req.subject) {
          return err({ kind: "IdempotencyKeyReused" } as const);
        }
        const decision = await liveDecision(tx, existing.id);
        return ok({ requestId: existing.id, outcome: null, decision, replayed: true });
      }

      const [row] = await tx
        .insert(approvalRequest)
        .values({
          candidateId: input.candidateId,
          kind: req.kind,
          subject: req.subject,
          facts: req.facts,
          actor: req.actor,
          idempotencyKey: req.idempotencyKey,
          requestedAt: input.now,
        })
        .returning({ id: approvalRequest.id });
      if (!row) throw new Error("approval_request insert returned no row");
      await appendEvent(tx, {
        candidateId: input.candidateId,
        requestId: row.id,
        type: "approval.requested",
        actor: req.actor,
        reason: "Waiting for approval",
        payload: { kind: req.kind, subject: req.subject },
        idempotencyKey: `approval_request:${row.id}`,
        at: input.now,
      });

      // Plain code decides whether Paul may be skipped; no set means everything waits.
      const set = await currentPolicySet(tx, input.candidateId);
      const outcome = evaluatePolicies(req.kind, req.facts, set?.rules ?? []);
      if (!outcome.auto || !set) {
        return ok({ requestId: row.id, outcome, decision: null, replayed: false });
      }
      const decision = await insertDecision(
        tx,
        {
          candidateId: input.candidateId,
          requestId: row.id,
          decision: "approved",
          decidedBy: "policy",
          policySetId: set.id,
          ruleName: outcome.rule,
          decidedAt: input.now,
          effectiveAt: new Date(input.now.getTime() + UNDO_WINDOW_MS),
        },
        input.candidateId,
        "system",
      );
      return ok({ requestId: row.id, outcome, decision, replayed: false });
    });
  });
}

// Replaces Paul's auto-approve rules with a new set. The old set stays for the audit trail. An
// empty set turns auto-approval off.
export async function setApprovalPolicies(
  db: Db,
  input: { candidateId: CandidateId; rules: unknown; now: Date },
): Promise<Result<{ policySetId: string; version: number }, InvalidPolicySet>> {
  return inSpan("approval.policies_set", {}, async () => {
    const parsed = parsePolicySet(input.rules);
    if (!parsed.ok) return parsed;
    return db.transaction(async (tx) => {
      const [row] = await tx
        .insert(approvalPolicySet)
        .values({ candidateId: input.candidateId, rules: parsed.value, createdAt: input.now })
        .returning({ id: approvalPolicySet.id, version: approvalPolicySet.version });
      if (!row) throw new Error("approval_policy_set insert returned no row");
      const event = parseDomainEvent({
        id: randomUUID(),
        candidateId: input.candidateId,
        aggregate: `approval_policy_set:${row.id}`,
        type: "approval.policies_set",
        actor: "user",
        reason:
          parsed.value.length === 0 ? "Auto-approval turned off" : "Auto-approve rules updated",
        inputsSummary: "",
        payload: { rules: parsed.value.length, version: row.version },
        links: [],
        traceId: traceId(),
        idempotencyKey: `approval_policy_set:${row.id}`,
        occurredAt: input.now,
      });
      if (!event.ok) throw new Error(`invalid approval event: ${event.error.fields.join(", ")}`);
      await tx.insert(domainEvent).values(event.value);
      return ok({ policySetId: row.id, version: row.version });
    });
  });
}

// The rules in force, for showing Paul. An empty list when he never set any.
export async function readApprovalPolicies(
  db: Db,
  candidateId: CandidateId,
): Promise<PolicyRule[]> {
  return db.transaction(async (tx) => (await currentPolicySet(tx, candidateId))?.rules ?? []);
}

// One queue for everything waiting for Paul (APR-001): requests with no live decision, oldest
// first. Pass a kind to see only that kind.
export async function listPendingApprovals(
  db: Db,
  candidateId: CandidateId,
  kind?: ApprovalKind,
): Promise<PendingApproval[]> {
  const rows = await db
    .select({
      requestId: approvalRequest.id,
      kind: approvalRequest.kind,
      subject: approvalRequest.subject,
      requestedAt: approvalRequest.requestedAt,
    })
    .from(approvalRequest)
    .where(
      and(
        eq(approvalRequest.candidateId, candidateId),
        kind ? eq(approvalRequest.kind, kind) : undefined,
        sql`not exists (
          select 1 from ${approvalDecision} d
          where d.request_id = ${approvalRequest.id}
            and not exists (select 1 from ${approvalUndo} u where u.decision_id = d.id)
        )`,
      ),
    )
    .orderBy(asc(approvalRequest.requestedAt), asc(approvalRequest.id));
  return rows.map((r) => ({ ...r, kind: r.kind as ApprovalKind }));
}

export type BatchOutcome = { requestId: string; result: Result<DecisionView, DecideError> };

// Paul approves or rejects one or many requests (APR-002, APPLY-005: "approve all" is the pending
// list's ids). Each request gets its own outcome and its own transaction, so one bad id never
// sinks the rest. A rejection needs a reason; it is stored, never put in an event.
export async function decideApprovals(
  db: Db,
  input: {
    candidateId: CandidateId;
    requestIds: readonly string[];
    decision: "approve" | "reject";
    reason?: string;
    now: Date;
  },
): Promise<Result<BatchOutcome[], ReasonRequired>> {
  const reason = input.reason?.trim() ?? "";
  if (input.decision === "reject" && reason.length === 0) {
    return err({ kind: "ReasonRequired" });
  }
  const outcomes: BatchOutcome[] = [];
  // The same id twice in one batch is decided once.
  for (const requestId of [...new Set(input.requestIds)]) {
    const result = await inSpan(
      "approval.decide",
      { "northstar.approval.decision": input.decision },
      () => decideOne(db, input, requestId, reason),
    );
    outcomes.push({ requestId, result });
  }
  return ok(outcomes);
}

async function decideOne(
  db: Db,
  input: { candidateId: CandidateId; decision: "approve" | "reject"; now: Date },
  requestId: string,
  reason: string,
): Promise<Result<DecisionView, DecideError>> {
  if (!Uuid.safeParse(requestId).success) return err({ kind: "NotFound" });
  try {
    return await db.transaction(async (tx) => {
      // Lock the request so two deciders are serialized (the insert trigger locks it too).
      const [request] = await tx
        .select({ id: approvalRequest.id })
        .from(approvalRequest)
        .where(
          and(
            eq(approvalRequest.id, requestId),
            eq(approvalRequest.candidateId, input.candidateId),
          ),
        )
        .for("update");
      if (!request) return err({ kind: "NotFound" } as const);
      if (await liveDecision(tx, requestId)) return err({ kind: "AlreadyDecided" } as const);
      const view = await insertDecision(
        tx,
        {
          candidateId: input.candidateId,
          requestId,
          decision: input.decision === "approve" ? "approved" : "rejected",
          decidedBy: "user",
          reason: input.decision === "reject" ? reason : null,
          decidedAt: input.now,
          effectiveAt: new Date(input.now.getTime() + UNDO_WINDOW_MS),
        },
        input.candidateId,
        "user",
      );
      return ok(view);
    });
  } catch (error) {
    // The one-live-decision trigger refused a decision that raced in after our check.
    if (pgCode(error) === "23505") return err({ kind: "AlreadyDecided" });
    throw error;
  }
}

// Paul takes a decision back inside its undo window; the request is pending again.
export async function undoDecision(
  db: Db,
  input: { candidateId: CandidateId; decisionId: string; now: Date },
): Promise<Result<{ requestId: string }, UndoError>> {
  return inSpan("approval.undo", {}, async () => {
    if (!Uuid.safeParse(input.decisionId).success) return err({ kind: "NotFound" });
    return db.transaction(async (tx) => {
      const [decision] = await tx
        .select()
        .from(approvalDecision)
        .where(
          and(
            eq(approvalDecision.id, input.decisionId),
            eq(approvalDecision.candidateId, input.candidateId),
          ),
        );
      if (!decision) return err({ kind: "NotFound" } as const);
      const [undone] = await tx
        .select({ id: approvalUndo.id })
        .from(approvalUndo)
        .where(eq(approvalUndo.decisionId, decision.id));
      if (undone) return err({ kind: "AlreadyUndone" } as const);
      if (input.now.getTime() >= decision.effectiveAt.getTime()) {
        return err({ kind: "UndoWindowClosed" } as const);
      }
      const [row] = await tx
        .insert(approvalUndo)
        .values({
          candidateId: input.candidateId,
          decisionId: decision.id,
          undoneAt: input.now,
        })
        .returning({ id: approvalUndo.id });
      if (!row) throw new Error("approval_undo insert returned no row");
      await appendEvent(tx, {
        candidateId: input.candidateId,
        requestId: decision.requestId,
        type: "approval.undone",
        actor: "user",
        reason: "Paul undid the decision; it is waiting again",
        payload: { decisionId: decision.id, undoId: row.id },
        idempotencyKey: `approval_undo:${row.id}`,
        at: input.now,
      });
      return ok({ requestId: decision.requestId });
    });
  });
}

export type VerifiedApproval = {
  decisionId: string;
  requestId: string;
  decidedBy: "user" | "policy";
  effectiveAt: Date;
};

// What every gateway calls before it acts (ADR-0002 item 3, APR-004). The id is the approvalId or
// policyDecisionId the caller was handed; it is looked up here, never trusted. Only a live
// approval of this exact kind and subject, past its undo window, passes. Fails closed: anything
// else is a named refusal.
export async function verifyApproval(
  db: Db,
  input: {
    candidateId: CandidateId;
    decisionId: string;
    kind: ApprovalKind;
    subject: string;
    now: Date;
  },
): Promise<Result<VerifiedApproval, VerifyError>> {
  return inSpan("approval.verify", { "northstar.approval.kind": input.kind }, async () => {
    if (!Uuid.safeParse(input.decisionId).success) return err({ kind: "NotFound" });
    const [row] = await db
      .select({
        decision: approvalDecision,
        kind: approvalRequest.kind,
        subject: approvalRequest.subject,
        undoId: approvalUndo.id,
      })
      .from(approvalDecision)
      .innerJoin(approvalRequest, eq(approvalRequest.id, approvalDecision.requestId))
      .leftJoin(approvalUndo, eq(approvalUndo.decisionId, approvalDecision.id))
      .where(
        and(
          eq(approvalDecision.id, input.decisionId),
          eq(approvalDecision.candidateId, input.candidateId),
        ),
      );
    if (!row) return err({ kind: "NotFound" });
    if (row.kind !== input.kind || row.subject !== input.subject) {
      return err({ kind: "SubjectMismatch" });
    }
    if (row.undoId !== null) return err({ kind: "Undone" });
    if (row.decision.decision !== "approved") return err({ kind: "Rejected" });
    if (input.now.getTime() < row.decision.effectiveAt.getTime()) {
      return err({ kind: "UndoWindowOpen", effectiveAt: row.decision.effectiveAt });
    }
    return ok({
      decisionId: row.decision.id,
      requestId: row.decision.requestId,
      decidedBy: row.decision.decidedBy as VerifiedApproval["decidedBy"],
      effectiveAt: row.decision.effectiveAt,
    });
  });
}

// The Postgres error code (SQLSTATE) of a failed query; Drizzle wraps driver errors in a cause.
function pgCode(error: unknown): string | null {
  const own = (error as { code?: unknown }).code;
  const cause = (error as { cause?: { code?: unknown } }).cause?.code;
  const code = typeof own === "string" ? own : cause;
  return typeof code === "string" ? code : null;
}
