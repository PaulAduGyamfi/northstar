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
  revealContentSha256,
} from "@northstar/domain";
import { isSpanContextValid, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  approvalDecision,
  approvalPolicySet,
  approvalRequest,
  approvalUndo,
  approvalWithdrawal,
} from "./approval-schema.js";
import type { Db } from "./db.js";
import { domainEvent } from "./schema.js";

// The Approval Gate (NS-119, ADR-0002, ADR-0017): requests, Paul's policies, decisions, undo and
// the check every gateway runs before it acts. The only writer of the approval_* tables. Events
// and spans carry ids, kinds and counts only: never a reject reason or any draft text.
// No function here takes a time: the database clock (northstar_gate_now(), migration 0016)
// stamps every record and decides whether an undo window is open, so a caller's clock can't
// shorten or stretch it.

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
export type SubjectAlreadyRequested = { kind: "SubjectAlreadyRequested" };
export type ReasonRequired = { kind: "ReasonRequired" };
export type NotFound = { kind: "NotFound" };
export type AlreadyDecided = { kind: "AlreadyDecided" };
export type AlreadyUndone = { kind: "AlreadyUndone" };
export type UndoWindowClosed = { kind: "UndoWindowClosed" };
// Another request for the same subject is open, so this (older) decision stands.
export type SubjectReopened = { kind: "SubjectReopened" };
export type Rejected = { kind: "Rejected" };
export type Undone = { kind: "Undone" };
export type UndoWindowOpen = { kind: "UndoWindowOpen"; effectiveAt: Date };
export type SubjectMismatch = { kind: "SubjectMismatch" };
export type ContentChanged = { kind: "ContentChanged" };
// The request was withdrawn (NS-140): closed, neither pending nor approved.
export type Withdrawn = { kind: "Withdrawn" };
// Withdrawing: the request is already closed by a rejection, or was withdrawn before.
export type AlreadyClosed = { kind: "AlreadyClosed" };
// A gateway may only withdraw an approval whose content really changed, and only an approval.
export type ContentUnchanged = { kind: "ContentUnchanged" };
export type NotApproved = { kind: "NotApproved" };

export type RequestError = InvalidRequest | IdempotencyKeyReused | SubjectAlreadyRequested;
export type DecideError = NotFound | AlreadyDecided | Withdrawn;
export type UndoError = NotFound | AlreadyUndone | UndoWindowClosed | SubjectReopened | Withdrawn;
export type VerifyError =
  | NotFound
  | Rejected
  | Undone
  | UndoWindowOpen
  | SubjectMismatch
  | ContentChanged
  | Withdrawn;
export type WithdrawError =
  | NotFound
  | AlreadyClosed
  | ContentUnchanged
  | NotApproved
  | UndoWindowOpen;

const Subject = z
  .string()
  .regex(/^[a-z_]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const Uuid = z.uuid();
const RequestInput = z.object({
  kind: ApprovalKind,
  subject: Subject,
  contentSha256: Sha256,
  // Only application packages carry facts; every other kind has none to give a policy. Facts
  // come from the producer, so only plain-code workflow activities may call requestApproval with
  // them, never an agent that read untrusted text (NFR-SEC-004, ADR-0017).
  facts: PackageFacts.nullable(),
  actor: z.string().regex(/^(agent:[a-z0-9-]+|system)$/),
  idempotencyKey: z.string().min(1).max(200),
});

// SQLSTATEs the Gate's own constraints and triggers raise (migrations 0015, 0016).
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const EXCLUSION_VIOLATION = "23P01";

const tracer = () => trace.getTracer("@northstar/db");

// Runs fn inside a span; an expected refusal marks the span with its kind, a throw with
// "DatabaseError" only (never row data).
async function inSpan<R extends { ok: true } | { ok: false; error: { kind: string } }>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<R>,
): Promise<R> {
  return tracer().startActiveSpan(name, async (span) => {
    span.setAttributes(attributes);
    try {
      const result = await fn(span);
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

// The span is passed down explicitly (as in transitionApplication) rather than read from the
// active context, which is empty when no context manager is registered.

// The span's trace id, or null when tracing is off (an all-zero context).
function traceIdOf(span: Span): string | null {
  const context = span.spanContext();
  return isSpanContextValid(context) ? context.traceId : null;
}

// The Gate's clock (northstar_gate_now(), migration 0016). Both drivers return { rows }.
async function gateNow(tx: Tx): Promise<Date> {
  const result = (await tx.execute(sql`select northstar_gate_now() as now`)) as unknown as {
    rows: { now: Date | string }[];
  };
  const value = result.rows[0]?.now;
  if (value === undefined) throw new Error("northstar_gate_now() returned no row");
  return new Date(value);
}

async function appendEvent(
  tx: Tx,
  span: Span,
  e: {
    candidateId: CandidateId;
    aggregate: string;
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
    aggregate: e.aggregate,
    type: e.type,
    actor: e.actor,
    reason: e.reason,
    inputsSummary: "",
    payload: e.payload,
    links: [],
    traceId: traceIdOf(span),
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

// A request is withdrawn (NS-140) once it has a withdrawal row: closed for good.
const notWithdrawn = sql`not exists (
  select 1 from ${approvalWithdrawal} w where w.request_id = ${approvalRequest.id}
)`;

async function isWithdrawn(tx: Tx, requestId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: approvalWithdrawal.id })
    .from(approvalWithdrawal)
    .where(eq(approvalWithdrawal.requestId, requestId));
  return row !== undefined;
}

async function decisionWithdrawn(tx: Tx, decisionId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: approvalWithdrawal.id })
    .from(approvalWithdrawal)
    .innerJoin(approvalDecision, eq(approvalDecision.requestId, approvalWithdrawal.requestId))
    .where(eq(approvalDecision.id, decisionId));
  return row !== undefined;
}

// The policy set in force: the newest one for this candidate, or null if Paul never set one.
// Its rules are checked again on the way out: a row that no longer parses (written by hand, or
// by an older schema) counts as no rules, so everything waits for Paul instead of a missing
// field silently passing a condition.
async function currentPolicySet(
  tx: Tx,
  candidateId: CandidateId,
  span?: Span,
): Promise<{ id: string; rules: PolicyRule[] } | null> {
  const [row] = await tx
    .select({ id: approvalPolicySet.id, rules: approvalPolicySet.rules })
    .from(approvalPolicySet)
    .where(eq(approvalPolicySet.candidateId, candidateId))
    .orderBy(desc(approvalPolicySet.version))
    .limit(1);
  if (!row) return null;
  const parsed = parsePolicySet(row.rules);
  if (!parsed.ok) {
    span?.setAttribute("northstar.approval.policy_set_invalid", true);
    return { id: row.id, rules: [] };
  }
  return { id: row.id, rules: parsed.value };
}

// Has Paul ever rejected this subject, undone a decision on it, or withdrawn it? Then no policy
// may approve it.
async function declinedBefore(tx: Tx, candidateId: CandidateId, subject: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: approvalDecision.id })
    .from(approvalDecision)
    .innerJoin(approvalRequest, eq(approvalRequest.id, approvalDecision.requestId))
    .where(
      and(
        eq(approvalRequest.candidateId, candidateId),
        eq(approvalRequest.subject, subject),
        sql`(${approvalDecision.decision} = 'rejected' or exists (
          select 1 from ${approvalUndo} where ${approvalUndo.decisionId} = ${approvalDecision.id}))`,
      ),
    )
    .limit(1);
  if (row) return true;
  // A subject Paul withdrew (NS-140) counts the same: he took it back, so it waits for him.
  const [withdrawn] = await tx
    .select({ id: approvalWithdrawal.id })
    .from(approvalWithdrawal)
    .innerJoin(approvalRequest, eq(approvalRequest.id, approvalWithdrawal.requestId))
    .where(
      and(
        eq(approvalRequest.candidateId, candidateId),
        eq(approvalRequest.subject, subject),
        eq(approvalWithdrawal.withdrawnBy, "user"),
      ),
    )
    .limit(1);
  return withdrawn !== undefined;
}

async function insertDecision(
  tx: Tx,
  span: Span,
  values: Omit<typeof approvalDecision.$inferInsert, "decidedAt" | "effectiveAt">,
  candidateId: CandidateId,
  actor: string,
): Promise<DecisionView> {
  // The trigger overwrites both times from the database clock; these only satisfy NOT NULL.
  const now = await gateNow(tx);
  const [row] = await tx
    .insert(approvalDecision)
    .values({ ...values, decidedAt: now, effectiveAt: now })
    .returning();
  if (!row) throw new Error("approval_decision insert returned no row");
  const view = toDecisionView(row);
  await appendEvent(tx, span, {
    candidateId,
    // Every event about a request is keyed by it, so the feed shows one request's history.
    aggregate: `approval:${view.requestId}`,
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

type RequestInputs = {
  candidateId: CandidateId;
  kind: ApprovalKind;
  subject: string;
  contentSha256: string;
  facts: PackageFacts | null;
  actor: string;
  idempotencyKey: string;
};

// Puts something in Paul's queue (APR-001) and runs his policies on it (ADR-0002 item 2). The
// same idempotency key twice returns the first request and writes nothing. A subject already
// pending or approved can't be requested again; one Paul rejected may be, and then always waits
// for him.
export async function requestApproval(
  db: Db,
  input: RequestInputs,
): Promise<Result<RequestResult, RequestError>> {
  return inSpan("approval.request", { "northstar.approval.kind": input.kind }, async (span) => {
    const parsed = RequestInput.safeParse(input);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
      return err({ kind: "InvalidRequest", fields });
    }
    if (parsed.data.kind !== "application_package" && parsed.data.facts !== null) {
      return err({ kind: "InvalidRequest", fields: ["facts"] });
    }
    // A reveal is filed, decided and used in one transaction by revealSealedSecret (NS-182,
    // ADR-0024), never through the queue: an agent must not be able to put one before Paul.
    if (parsed.data.kind === "vault_reveal") {
      return err({ kind: "InvalidRequest", fields: ["kind"] });
    }
    try {
      return await requestOnce(db, span, input.candidateId, parsed.data);
    } catch (error) {
      const code = pgCode(error);
      // A concurrent call committed first. With the same key (23505), or with the same key and
      // subject (the subject trigger fires before the key's unique check, 23P01), this call is
      // its replay; running again checks the key first and returns the first request, or
      // reports SubjectAlreadyRequested as a value when it was a different request.
      if (code === UNIQUE_VIOLATION || code === EXCLUSION_VIOLATION) {
        return requestOnce(db, span, input.candidateId, parsed.data);
      }
      throw error;
    }
  });
}

async function requestOnce(
  db: Db,
  span: Span,
  candidateId: CandidateId,
  req: z.infer<typeof RequestInput>,
): Promise<Result<RequestResult, RequestError>> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(approvalRequest)
      .where(
        and(
          eq(approvalRequest.candidateId, candidateId),
          eq(approvalRequest.idempotencyKey, req.idempotencyKey),
        ),
      );
    if (existing) {
      // Facts are not compared: they describe the content, which the hash already pins.
      const same =
        existing.kind === req.kind &&
        existing.subject === req.subject &&
        existing.contentSha256 === req.contentSha256;
      if (!same) return err({ kind: "IdempotencyKeyReused" } as const);
      const decision = await liveDecision(tx, existing.id);
      return ok({ requestId: existing.id, outcome: null, decision, replayed: true });
    }

    // Same rule as the insert trigger, checked first so the usual case is a value, not a throw.
    const [open] = await tx
      .select({ id: approvalRequest.id })
      .from(approvalRequest)
      .where(
        and(
          eq(approvalRequest.candidateId, candidateId),
          eq(approvalRequest.subject, req.subject),
          notWithdrawn,
          sql`not exists (
            select 1 from ${approvalDecision} d
            where d.request_id = ${approvalRequest.id} and d.decision = 'rejected'
              and not exists (select 1 from ${approvalUndo} u where u.decision_id = d.id)
          )`,
        ),
      )
      .limit(1);
    if (open) return err({ kind: "SubjectAlreadyRequested" } as const);

    // requested_at is overwritten by the trigger from the database clock.
    const now = await gateNow(tx);
    const [row] = await tx
      .insert(approvalRequest)
      .values({
        candidateId,
        kind: req.kind,
        subject: req.subject,
        contentSha256: req.contentSha256,
        facts: req.facts,
        actor: req.actor,
        idempotencyKey: req.idempotencyKey,
        requestedAt: now,
      })
      .returning({ id: approvalRequest.id, requestedAt: approvalRequest.requestedAt });
    if (!row) throw new Error("approval_request insert returned no row");
    await appendEvent(tx, span, {
      candidateId,
      aggregate: `approval:${row.id}`,
      type: "approval.requested",
      actor: req.actor,
      reason: "Waiting for approval",
      payload: { kind: req.kind, subject: req.subject },
      idempotencyKey: `approval_request:${row.id}`,
      at: row.requestedAt,
    });

    // Plain code decides whether Paul may be skipped; no set means everything waits.
    const set = await currentPolicySet(tx, candidateId, span);
    let outcome = evaluatePolicies(req.kind, req.facts, set?.rules ?? []);
    if (outcome.auto && (await declinedBefore(tx, candidateId, req.subject))) {
      outcome = { auto: false, why: "declined_before" };
    }
    if (!outcome.auto || !set) {
      return ok({ requestId: row.id, outcome, decision: null, replayed: false });
    }
    const decision = await insertDecision(
      tx,
      span,
      {
        candidateId,
        requestId: row.id,
        decision: "approved",
        decidedBy: "policy",
        policySetId: set.id,
        ruleName: outcome.rule,
      },
      candidateId,
      "system",
    );
    return ok({ requestId: row.id, outcome, decision, replayed: false });
  });
}

// Replaces Paul's auto-approve rules with a new set. The old set stays for the audit trail. An
// empty set turns auto-approval off for new requests; an auto-approval still in its undo window
// stays (Paul can undo it).
export async function setApprovalPolicies(
  db: Db,
  input: { candidateId: CandidateId; rules: unknown },
): Promise<Result<{ policySetId: string; version: number }, InvalidPolicySet>> {
  return inSpan("approval.policies_set", {}, async (span) => {
    const parsed = parsePolicySet(input.rules);
    if (!parsed.ok) return parsed;
    return db.transaction(async (tx) => {
      // created_at is overwritten by the trigger from the database clock.
      const [row] = await tx
        .insert(approvalPolicySet)
        .values({ candidateId: input.candidateId, rules: parsed.value, createdAt: new Date(0) })
        .returning({
          id: approvalPolicySet.id,
          version: approvalPolicySet.version,
          createdAt: approvalPolicySet.createdAt,
        });
      if (!row) throw new Error("approval_policy_set insert returned no row");
      await appendEvent(tx, span, {
        candidateId: input.candidateId,
        aggregate: `approval_policy_set:${row.id}`,
        type: "approval.policies_set",
        actor: "user",
        reason:
          parsed.value.length === 0 ? "Auto-approval turned off" : "Auto-approve rules updated",
        payload: { rules: parsed.value.length, version: row.version },
        idempotencyKey: `approval_policy_set:${row.id}`,
        at: row.createdAt,
      });
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
        // Reveals are decided as they are filed (ADR-0024); one never waits in the queue.
        sql`${approvalRequest.kind} <> 'vault_reveal'`,
        notWithdrawn,
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
// sinks the rest. A rejection needs a reason; it is stored, never put in an event or span.
export async function decideApprovals(
  db: Db,
  input: {
    candidateId: CandidateId;
    requestIds: readonly string[];
    decision: "approve" | "reject";
    reason?: string;
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
      (span) => decideOne(db, span, input, requestId, reason),
    );
    outcomes.push({ requestId, result });
  }
  return ok(outcomes);
}

async function decideOne(
  db: Db,
  span: Span,
  input: { candidateId: CandidateId; decision: "approve" | "reject" },
  requestId: string,
  reason: string,
): Promise<Result<DecisionView, DecideError>> {
  if (!Uuid.safeParse(requestId).success) return err({ kind: "NotFound" });
  try {
    return await db.transaction(async (tx) => {
      // Lock the request so two deciders are serialized (the insert trigger locks it too).
      const [request] = await tx
        .select({ id: approvalRequest.id, kind: approvalRequest.kind })
        .from(approvalRequest)
        .where(
          and(
            eq(approvalRequest.id, requestId),
            eq(approvalRequest.candidateId, input.candidateId),
          ),
        )
        .for("update");
      // A reveal is never decided from the queue (ADR-0024): it isn't in it.
      if (!request || request.kind === "vault_reveal") return err({ kind: "NotFound" } as const);
      span.setAttribute("northstar.approval.kind", request.kind);
      if (await isWithdrawn(tx, requestId)) return err({ kind: "Withdrawn" } as const);
      if (await liveDecision(tx, requestId)) return err({ kind: "AlreadyDecided" } as const);
      const view = await insertDecision(
        tx,
        span,
        {
          candidateId: input.candidateId,
          requestId,
          decision: input.decision === "approve" ? "approved" : "rejected",
          decidedBy: "user",
          reason: input.decision === "reject" ? reason : null,
        },
        input.candidateId,
        "user",
      );
      return ok(view);
    });
  } catch (error) {
    // The one-live-decision trigger refused a decision that raced in after our check.
    if (pgCode(error) === UNIQUE_VIOLATION) return err({ kind: "AlreadyDecided" });
    // The decision trigger refused it: only on a withdrawn request (its other check failures
    // apply to policy decisions only).
    if (pgCode(error) === CHECK_VIOLATION) return err({ kind: "Withdrawn" });
    throw error;
  }
}

// Paul takes a decision back inside its undo window; the request is pending again. The window is
// judged by the database clock, here and in the trigger.
export async function undoDecision(
  db: Db,
  input: { candidateId: CandidateId; decisionId: string },
): Promise<Result<{ requestId: string }, UndoError>> {
  return inSpan("approval.undo", {}, async (span) => {
    if (!Uuid.safeParse(input.decisionId).success) return err({ kind: "NotFound" });
    try {
      return await undoOnce(db, span, input);
    } catch (error) {
      const code = pgCode(error);
      // A concurrent undo of the same decision committed first.
      if (code === UNIQUE_VIOLATION) return err({ kind: "AlreadyUndone" });
      // The trigger refused it: the request was withdrawn in the meantime, or the window closed.
      if (code === CHECK_VIOLATION) {
        const withdrawn = await db.transaction((tx) => decisionWithdrawn(tx, input.decisionId));
        return err({ kind: withdrawn ? "Withdrawn" : "UndoWindowClosed" });
      }
      // A request for the same subject opened between our check and the insert.
      if (code === EXCLUSION_VIOLATION) return err({ kind: "SubjectReopened" });
      throw error;
    }
  });
}

async function undoOnce(
  db: Db,
  span: Span,
  input: { candidateId: CandidateId; decisionId: string },
): Promise<Result<{ requestId: string }, UndoError>> {
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select({
        decision: approvalDecision,
        kind: approvalRequest.kind,
        subject: approvalRequest.subject,
      })
      .from(approvalDecision)
      .innerJoin(approvalRequest, eq(approvalRequest.id, approvalDecision.requestId))
      .where(
        and(
          eq(approvalDecision.id, input.decisionId),
          eq(approvalDecision.candidateId, input.candidateId),
        ),
      );
    if (!found) return err({ kind: "NotFound" } as const);
    const decision = found.decision;
    span.setAttribute("northstar.approval.kind", found.kind);
    // A withdrawn request is closed: its decision can't be taken back into the queue.
    if (await isWithdrawn(tx, decision.requestId)) return err({ kind: "Withdrawn" } as const);
    const [undone] = await tx
      .select({ id: approvalUndo.id })
      .from(approvalUndo)
      .where(eq(approvalUndo.decisionId, decision.id));
    if (undone) return err({ kind: "AlreadyUndone" } as const);
    const now = await gateNow(tx);
    if (now.getTime() >= decision.effectiveAt.getTime()) {
      return err({ kind: "UndoWindowClosed" } as const);
    }
    // Same rule as the undo trigger: undoing this would reopen its request while another request
    // for the subject is open (only possible after this decision rejected it).
    const [otherOpen] = await tx
      .select({ id: approvalRequest.id })
      .from(approvalRequest)
      .where(
        and(
          eq(approvalRequest.candidateId, input.candidateId),
          eq(approvalRequest.subject, found.subject),
          sql`${approvalRequest.id} <> ${decision.requestId}`,
          notWithdrawn,
          sql`not exists (
            select 1 from ${approvalDecision} d
            where d.request_id = ${approvalRequest.id} and d.decision = 'rejected'
              and not exists (select 1 from ${approvalUndo} u where u.decision_id = d.id)
          )`,
        ),
      )
      .limit(1);
    if (otherOpen) return err({ kind: "SubjectReopened" } as const);
    // undone_at is overwritten by the trigger from the database clock.
    const [row] = await tx
      .insert(approvalUndo)
      .values({ candidateId: input.candidateId, decisionId: decision.id, undoneAt: now })
      .returning({ id: approvalUndo.id, undoneAt: approvalUndo.undoneAt });
    if (!row) throw new Error("approval_undo insert returned no row");
    await appendEvent(tx, span, {
      candidateId: input.candidateId,
      aggregate: `approval:${decision.requestId}`,
      type: "approval.undone",
      actor: "user",
      reason: "Paul undid the decision; it is waiting again",
      payload: { decisionId: decision.id, undoId: row.id },
      idempotencyKey: `approval_undo:${row.id}`,
      at: row.undoneAt,
    });
    return ok({ requestId: decision.requestId });
  });
}

export type VerifiedApproval = {
  decisionId: string;
  requestId: string;
  decidedBy: "user" | "policy";
  effectiveAt: Date;
};

// What every gateway calls at the moment it acts (ADR-0002 item 3, APR-004). The id is the
// approvalId or policyDecisionId the caller was handed; it is looked up here, never trusted. Only
// a live approval of this exact kind, subject and content (the SHA-256 of what the gateway is
// about to send), past its undo window by the database clock, passes. Fails closed: anything else
// is a named refusal. It can be called any number of times, so a gateway's idempotency key must
// come from the decision id: one approval, one send.
export async function verifyApproval(
  db: Db,
  input: {
    candidateId: CandidateId;
    decisionId: string;
    kind: ApprovalKind;
    subject: string;
    contentSha256: string;
  },
): Promise<Result<VerifiedApproval, VerifyError>> {
  return inSpan("approval.verify", { "northstar.approval.kind": input.kind }, async () => {
    if (!Uuid.safeParse(input.decisionId).success) return err({ kind: "NotFound" });
    return db.transaction(async (tx) => {
      // Lock the decision row: an undo locks it too (migration 0016), so an undo committing at the
      // edge of the window and this check never overlap. Whichever comes first, the other sees it.
      await tx
        .select({ id: approvalDecision.id })
        .from(approvalDecision)
        .where(
          and(
            eq(approvalDecision.id, input.decisionId),
            eq(approvalDecision.candidateId, input.candidateId),
          ),
        )
        .for("update");
      const [row] = await tx
        .select({
          decision: approvalDecision,
          kind: approvalRequest.kind,
          subject: approvalRequest.subject,
          contentSha256: approvalRequest.contentSha256,
          undoId: approvalUndo.id,
          // Judged by the database clock, the same one that stamped effective_at.
          effective: sql<boolean>`${approvalDecision.effectiveAt} <= northstar_gate_now()`,
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
      // Withdrawn first: a closed request refuses whatever content is offered.
      if (await isWithdrawn(tx, row.decision.requestId)) return err({ kind: "Withdrawn" });
      if (row.contentSha256 !== input.contentSha256) return err({ kind: "ContentChanged" });
      if (row.undoId !== null) return err({ kind: "Undone" });
      if (row.decision.decision !== "approved") return err({ kind: "Rejected" });
      if (row.effective !== true) {
        return err({ kind: "UndoWindowOpen", effectiveAt: row.decision.effectiveAt });
      }
      return ok({
        decisionId: row.decision.id,
        requestId: row.decision.requestId,
        decidedBy: row.decision.decidedBy as VerifiedApproval["decidedBy"],
        effectiveAt: row.decision.effectiveAt,
      });
    });
  });
}

// The request a decision belongs to (NS-211), read-only. A gateway holds only the decision id it
// was handed; when verifyApproval refuses with ContentChanged, this gives it the request id
// withdrawApproval needs. Scoped by candidate: another candidate's decision is NotFound. It
// proves nothing about the approval: withdrawApproval re-checks everything itself.
export async function requestOfDecision(
  db: Db,
  input: { candidateId: CandidateId; decisionId: string },
): Promise<Result<{ requestId: string }, NotFound>> {
  return inSpan("approval.request_of", {}, async () => {
    if (!Uuid.safeParse(input.decisionId).success) return err({ kind: "NotFound" });
    const [row] = await db
      .select({ requestId: approvalDecision.requestId })
      .from(approvalDecision)
      .where(
        and(
          eq(approvalDecision.id, input.decisionId),
          eq(approvalDecision.candidateId, input.candidateId),
        ),
      );
    return row ? ok({ requestId: row.requestId }) : err({ kind: "NotFound" });
  });
}

// The Postgres error code (SQLSTATE) of a failed query; Drizzle wraps driver errors in a cause.
function pgCode(error: unknown): string | null {
  const own = (error as { code?: unknown }).code;
  const cause = (error as { cause?: { code?: unknown } }).cause?.code;
  const code = typeof own === "string" ? own : cause;
  return typeof code === "string" ? code : null;
}

export type WithdrawInput =
  | { candidateId: CandidateId; requestId: string; by: "user" }
  // A gateway proves the content changed: the SHA-256 of what it now holds must differ from the
  // approved content. It never asserts it.
  | { candidateId: CandidateId; requestId: string; by: "gateway"; newContentSha256: string };

export type WithdrawResult = { withdrawalId: string; requestId: string; decisionId: string | null };

// Closes a request (NS-140, APR-004): Paul withdraws a pending or approved request, or a gateway
// withdraws an approval whose content changed for good. A withdrawn request is neither pending nor
// approved: verifyApproval refuses it, it leaves the queue, and its subject may be requested
// again (after Paul's withdrawal, that request always waits for him). The trigger (migration
// 0037) takes the same locks an undo does, so a withdrawal and a gateway's check never overlap.
export async function withdrawApproval(
  db: Db,
  input: WithdrawInput,
): Promise<Result<WithdrawResult, WithdrawError>> {
  return inSpan(
    "approval.withdraw",
    { "northstar.approval.withdrawn_by": input.by },
    async (span) => {
      if (!Uuid.safeParse(input.requestId).success) return err({ kind: "NotFound" });
      if (input.by === "gateway" && !Sha256.safeParse(input.newContentSha256).success) {
        return err({ kind: "NotFound" });
      }
      try {
        return await withdrawOnce(db, span, input);
      } catch (error) {
        const code = pgCode(error);
        // A concurrent withdrawal of the same request committed first.
        if (code === UNIQUE_VIOLATION) return err({ kind: "AlreadyClosed" });
        // The trigger refused it: rejected (closed) in the meantime, or no longer an approval.
        if (code === CHECK_VIOLATION) {
          return err({ kind: input.by === "gateway" ? "NotApproved" : "AlreadyClosed" });
        }
        throw error;
      }
    },
  );
}

async function withdrawOnce(
  db: Db,
  span: Span,
  input: WithdrawInput,
): Promise<Result<WithdrawResult, WithdrawError>> {
  return db.transaction(async (tx) => {
    const [request] = await tx
      .select({
        id: approvalRequest.id,
        kind: approvalRequest.kind,
        contentSha256: approvalRequest.contentSha256,
      })
      .from(approvalRequest)
      .where(
        and(
          eq(approvalRequest.id, input.requestId),
          eq(approvalRequest.candidateId, input.candidateId),
        ),
      );
    if (!request) return err({ kind: "NotFound" } as const);
    span.setAttribute("northstar.approval.kind", request.kind);
    if (await isWithdrawn(tx, request.id)) return err({ kind: "AlreadyClosed" } as const);
    const live = await liveDecision(tx, request.id);
    if (live?.decision === "rejected") return err({ kind: "AlreadyClosed" } as const);
    if (input.by === "gateway") {
      if (live?.decision !== "approved") return err({ kind: "NotApproved" } as const);
      // Inside the undo window the approval is still Paul's to undo; a gateway meets changed
      // content only when it acts, after the window (the trigger checks this too).
      if ((await gateNow(tx)).getTime() < live.effectiveAt.getTime()) {
        return err({ kind: "UndoWindowOpen", effectiveAt: live.effectiveAt } as const);
      }
      if (input.newContentSha256 === request.contentSha256) {
        return err({ kind: "ContentUnchanged" } as const);
      }
    }
    // withdrawn_at is overwritten by the trigger from the database clock.
    const now = await gateNow(tx);
    const [row] = await tx
      .insert(approvalWithdrawal)
      .values({
        candidateId: input.candidateId,
        requestId: request.id,
        withdrawnBy: input.by,
        reason: input.by === "user" ? "paul" : "content_changed",
        withdrawnAt: now,
      })
      .returning({ id: approvalWithdrawal.id, withdrawnAt: approvalWithdrawal.withdrawnAt });
    if (!row) throw new Error("approval_withdrawal insert returned no row");
    // Read again now the trigger holds the locks: a decision that committed after the first read
    // (Paul approving while he withdraws) is the one this withdrawal closed.
    const closed = await liveDecision(tx, request.id);
    await appendEvent(tx, span, {
      candidateId: input.candidateId,
      aggregate: `approval:${request.id}`,
      type: "approval.withdrawn",
      actor: input.by === "user" ? "user" : "system",
      reason:
        input.by === "user"
          ? "Paul withdrew it; it can be asked for again"
          : "Withdrawn because the approved content changed; it can be asked for again",
      // Ids and codes only: never content or its hashes.
      payload: {
        withdrawalId: row.id,
        decisionId: closed?.decisionId ?? null,
        withdrawnBy: input.by,
        reason: input.by === "user" ? "paul" : "content_changed",
      },
      idempotencyKey: `approval_withdrawal:${row.id}`,
      at: row.withdrawnAt,
    });
    return ok({
      withdrawalId: row.id,
      requestId: request.id,
      decisionId: live?.decisionId ?? null,
    });
  });
}

// Files and approves one `vault_reveal` for Paul inside the caller's transaction (NS-182,
// ADR-0024). Only revealSealedSecret (vault-write.ts) calls it, after his fresh passkey check in
// the API; it is not exported from the package. The request names the tenant by its content hash
// and is filed by `system`; the decision is Paul's and takes effect at once (migration 0057).
export async function approveRevealWithin(
  tx: Tx,
  span: Span,
  candidateId: CandidateId,
  tenantKey: string,
): Promise<string> {
  const id = randomUUID();
  const now = await gateNow(tx);
  const [row] = await tx
    .insert(approvalRequest)
    .values({
      candidateId,
      kind: "vault_reveal",
      subject: `vault_reveal:${id}`,
      contentSha256: revealContentSha256(tenantKey),
      facts: null,
      actor: "system",
      idempotencyKey: `vault_reveal:${id}`,
      requestedAt: now,
    })
    .returning({ id: approvalRequest.id, requestedAt: approvalRequest.requestedAt });
  if (!row) throw new Error("approval_request insert returned no row");
  await appendEvent(tx, span, {
    candidateId,
    aggregate: `approval:${row.id}`,
    type: "approval.requested",
    actor: "system",
    reason: "Paul asked to see a password",
    payload: { kind: "vault_reveal", subject: `vault_reveal:${id}` },
    idempotencyKey: `approval_request:${row.id}`,
    at: row.requestedAt,
  });
  const view = await insertDecision(
    tx,
    span,
    { candidateId, requestId: row.id, decision: "approved", decidedBy: "user", reason: null },
    candidateId,
    "user",
  );
  return view.decisionId;
}
