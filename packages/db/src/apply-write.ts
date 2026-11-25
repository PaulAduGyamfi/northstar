import { createHash, randomUUID } from "node:crypto";
import {
  type ApplyAts,
  type CandidateId,
  err,
  type NeedsHumanReason,
  ok,
  parseDomainEvent,
  type Result,
} from "@northstar/domain";
import { isSpanContextValid, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { and, desc, eq, sql } from "drizzle-orm";
import { type ApplyLimits, checkApplyLimits, DEFAULT_APPLY_LIMITS } from "./apply-config.js";
import { applySubmission, type SubmissionStatus, submissionProof } from "./apply-schema.js";
import type { Db } from "./db.js";
import { candidate, domainEvent } from "./schema.js";

// The Apply Gateway's ledger (NS-120): claims, outcomes and proof of submission. The only writer
// of apply_submission and submission_proof. Every time comes from the database clock
// (northstar_gate_now()), so pacing can't be skewed by a caller's clock. Events and spans carry
// ids, the ATS and reason codes only: never field values, URLs or page HTML.

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export { DEFAULT_DAILY_CAP, DEFAULT_MIN_GAP_MS } from "./apply-config.js";
// A claim still in progress this long after it started belongs to a run that died: no browser
// session lives this long (the gateway's driver timeouts add up to far less). Before that, the
// claim belongs to a run that may still be in the browser and must be left alone.
export const CLAIM_STALE_AFTER_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SubmissionView = {
  submissionId: string;
  applicationId: string;
  decisionId: string;
  ats: ApplyAts;
  status: SubmissionStatus;
  reason: NeedsHumanReason | null;
  startedAt: Date;
  finishedAt: Date | null;
};

export type ProofView = {
  proofId: string;
  submissionId: string;
  confirmationHtml: string;
  htmlSha256: string;
  screenshotPng: Uint8Array;
  screenshotSha256: string;
  fieldValues: Record<string, string | string[]>;
  resumeSha256: string;
  capturedAt: Date;
};

export type ClaimInput = {
  candidateId: CandidateId;
  applicationId: string;
  decisionId: string;
  ats: ApplyAts;
  postingId: string;
};

export type Claimed = { claimed: true; submission: SubmissionView };
// The idempotency key was used before: this is that submission, and nothing new was claimed.
// `stale`: still in_progress and older than CLAIM_STALE_AFTER_MS by the database clock.
export type Existing = {
  claimed: false;
  submission: SubmissionView;
  proof: ProofView | null;
  stale: boolean;
};

export type DuplicateRequisition = { kind: "DuplicateRequisition" };
export type AtsBusy = { kind: "AtsBusy" };
export type Paced = { kind: "Paced"; retryAt: Date };
export type DailyCapReached = { kind: "DailyCapReached"; retryAt: Date };
export type ClaimError = DuplicateRequisition | AtsBusy | Paced | DailyCapReached;
export type NotInProgress = { kind: "NotInProgress" };

export const submitIdempotencyKey = (applicationId: string): string =>
  `application:${applicationId}:submit`;
export const requisitionKey = (ats: ApplyAts, postingId: string): string => `${ats}:${postingId}`;

const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const tracer = () => trace.getTracer("@northstar/db");

// Runs fn in a span; an expected refusal marks it with its kind, a throw with "DatabaseError".
async function inSpan<R extends { ok: true } | { ok: false; error: { kind: string } }>(
  name: string,
  attributes: Record<string, string>,
  fn: (span: Span) => Promise<R>,
): Promise<R> {
  return tracer().startActiveSpan(name, async (span) => {
    span.setAttributes(attributes);
    try {
      const result = await fn(span);
      span.setAttribute("northstar.apply.outcome", result.ok ? "ok" : result.error.kind);
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
  candidateId: CandidateId,
  submissionId: string,
  what: "claimed" | "submitted" | "needs_human",
  payload: Record<string, unknown>,
  at: Date,
): Promise<void> {
  const context = span.spanContext();
  const parsed = parseDomainEvent({
    id: randomUUID(),
    candidateId,
    aggregate: `apply_submission:${submissionId}`,
    type: `apply_submission.${what}`,
    actor: "agent:apply",
    reason: "",
    inputsSummary: "",
    payload,
    links: [],
    traceId: isSpanContextValid(context) ? context.traceId : null,
    idempotencyKey: `apply_submission:${submissionId}:${what}`,
    occurredAt: at,
  });
  // Every field is built here, so a bad event is a bug, not an input error.
  if (!parsed.ok) throw new Error(`invalid apply event: ${parsed.error.fields.join(", ")}`);
  await tx.insert(domainEvent).values(parsed.value);
}

const toView = (r: typeof applySubmission.$inferSelect): SubmissionView => ({
  submissionId: r.id,
  applicationId: r.applicationId,
  decisionId: r.decisionId,
  ats: r.ats as ApplyAts,
  status: r.status as SubmissionStatus,
  reason: r.reason as NeedsHumanReason | null,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
});

const toProof = (r: typeof submissionProof.$inferSelect): ProofView => ({
  proofId: r.id,
  submissionId: r.submissionId,
  confirmationHtml: r.confirmationHtml,
  htmlSha256: r.htmlSha256,
  screenshotPng: new Uint8Array(r.screenshotPng),
  screenshotSha256: r.screenshotSha256,
  fieldValues: r.fieldValues,
  resumeSha256: r.resumeSha256,
  capturedAt: r.capturedAt,
});

async function proofOf(tx: Tx | Db, submissionId: string): Promise<ProofView | null> {
  const [row] = await tx
    .select()
    .from(submissionProof)
    .where(eq(submissionProof.submissionId, submissionId));
  return row ? toProof(row) : null;
}

// Claims the right to submit one application, before the browser does anything. In order: a
// used idempotency key returns that submission (never a second one); the same requisition is
// refused (APPLY-009); then pacing (APPLY-007): one in progress per ATS, a minimum gap per ATS
// and a cap over the last 24 hours. Claims are serialized per candidate by a row lock, so two
// workers can't both pass the cap. The limits come from the config module only (NS-143): an
// ApplyLimits value can't exceed APPLY-007's defaults, whoever passes it.
export async function claimSubmission(
  db: Db,
  input: ClaimInput,
  limits: ApplyLimits = DEFAULT_APPLY_LIMITS,
): Promise<Result<Claimed | Existing, ClaimError>> {
  const { dailyCap, minGapMs } = checkApplyLimits(limits);
  return inSpan("db.apply.claim", { "northstar.apply.ats": input.ats }, (span) =>
    db.transaction(async (tx): Promise<Result<Claimed | Existing, ClaimError>> => {
      await tx
        .select({ id: candidate.id })
        .from(candidate)
        .where(eq(candidate.id, input.candidateId))
        .for("update");
      const now = await gateNow(tx);
      const key = submitIdempotencyKey(input.applicationId);
      const [existing] = await tx
        .select()
        .from(applySubmission)
        .where(
          and(
            eq(applySubmission.candidateId, input.candidateId),
            eq(applySubmission.idempotencyKey, key),
          ),
        );
      if (existing) {
        return ok({
          claimed: false,
          submission: toView(existing),
          proof: await proofOf(tx, existing.id),
          stale:
            existing.status === "in_progress" &&
            now.getTime() - existing.startedAt.getTime() >= CLAIM_STALE_AFTER_MS,
        });
      }
      const requisition = requisitionKey(input.ats, input.postingId);
      const [sameRequisition] = await tx
        .select({ id: applySubmission.id })
        .from(applySubmission)
        .where(
          and(
            eq(applySubmission.candidateId, input.candidateId),
            eq(applySubmission.requisitionKey, requisition),
          ),
        );
      if (sameRequisition) return err({ kind: "DuplicateRequisition" });

      const sameAts = and(
        eq(applySubmission.candidateId, input.candidateId),
        eq(applySubmission.ats, input.ats),
      );
      const [busy] = await tx
        .select({ id: applySubmission.id })
        .from(applySubmission)
        .where(and(sameAts, eq(applySubmission.status, "in_progress")));
      if (busy) return err({ kind: "AtsBusy" });

      const [last] = await tx
        .select({ startedAt: applySubmission.startedAt })
        .from(applySubmission)
        .where(sameAts)
        .orderBy(desc(applySubmission.startedAt))
        .limit(1);
      if (last && now.getTime() - last.startedAt.getTime() < minGapMs) {
        return err({ kind: "Paced", retryAt: new Date(last.startedAt.getTime() + minGapMs) });
      }

      const since = new Date(now.getTime() - DAY_MS);
      const recent = await tx
        .select({ startedAt: applySubmission.startedAt })
        .from(applySubmission)
        .where(
          and(
            eq(applySubmission.candidateId, input.candidateId),
            sql`${applySubmission.startedAt} > ${since.toISOString()}`,
          ),
        )
        .orderBy(applySubmission.startedAt);
      if (recent.length >= dailyCap) {
        // The cap frees up when the oldest of the last 24 hours ages out.
        const oldest = recent[recent.length - dailyCap]?.startedAt ?? now;
        return err({ kind: "DailyCapReached", retryAt: new Date(oldest.getTime() + DAY_MS) });
      }

      const [row] = await tx
        .insert(applySubmission)
        .values({
          candidateId: input.candidateId,
          applicationId: input.applicationId,
          decisionId: input.decisionId,
          ats: input.ats,
          requisitionKey: requisition,
          idempotencyKey: key,
          status: "in_progress",
          startedAt: now,
        })
        .returning();
      if (!row) throw new Error("apply_submission insert returned no row");
      await appendEvent(
        tx,
        span,
        input.candidateId,
        row.id,
        "claimed",
        { applicationId: input.applicationId, decisionId: input.decisionId, ats: input.ats },
        now,
      );
      return ok({ claimed: true, submission: toView(row) });
    }),
  );
}

export type ProofInput = {
  confirmationHtml: string;
  screenshotPng: Uint8Array;
  fieldValues: Record<string, string | string[]>;
  resumeSha256: string;
};

// Marks an in-progress submission submitted and stores its proof (APPLY-008), in one transaction.
export async function recordSubmitted(
  db: Db,
  candidateId: CandidateId,
  submissionId: string,
  proof: ProofInput,
): Promise<Result<{ submission: SubmissionView; proof: ProofView }, NotInProgress>> {
  return inSpan("db.apply.submitted", {}, (span) =>
    db.transaction(async (tx) => {
      const now = await gateNow(tx);
      const [row] = await tx
        .update(applySubmission)
        .set({ status: "submitted", finishedAt: now })
        .where(
          and(
            eq(applySubmission.id, submissionId),
            eq(applySubmission.candidateId, candidateId),
            eq(applySubmission.status, "in_progress"),
          ),
        )
        .returning();
      if (!row) return err({ kind: "NotInProgress" as const });
      const [stored] = await tx
        .insert(submissionProof)
        .values({
          candidateId,
          submissionId,
          confirmationHtml: proof.confirmationHtml,
          htmlSha256: sha256(proof.confirmationHtml),
          screenshotPng: proof.screenshotPng,
          screenshotSha256: sha256(proof.screenshotPng),
          fieldValues: proof.fieldValues,
          resumeSha256: proof.resumeSha256,
          capturedAt: now,
        })
        .returning();
      if (!stored) throw new Error("submission_proof insert returned no row");
      await appendEvent(
        tx,
        span,
        candidateId,
        submissionId,
        "submitted",
        { applicationId: row.applicationId, ats: row.ats, proofId: stored.id },
        now,
      );
      return ok({ submission: toView(row), proof: toProof(stored) });
    }),
  );
}

// Marks an in-progress submission as waiting for Paul's hands, with a reason code.
export async function recordNeedsHuman(
  db: Db,
  candidateId: CandidateId,
  submissionId: string,
  reason: NeedsHumanReason,
): Promise<Result<SubmissionView, NotInProgress>> {
  return inSpan("db.apply.needs_human", { "northstar.apply.reason": reason }, (span) =>
    db.transaction(async (tx) => {
      const now = await gateNow(tx);
      const [row] = await tx
        .update(applySubmission)
        .set({ status: "needs_human", reason, finishedAt: now })
        .where(
          and(
            eq(applySubmission.id, submissionId),
            eq(applySubmission.candidateId, candidateId),
            eq(applySubmission.status, "in_progress"),
          ),
        )
        .returning();
      if (!row) return err({ kind: "NotInProgress" as const });
      await appendEvent(
        tx,
        span,
        candidateId,
        submissionId,
        "needs_human",
        { applicationId: row.applicationId, ats: row.ats, reason },
        now,
      );
      return ok(toView(row));
    }),
  );
}

// Every claim of this candidate still in progress at least CLAIM_STALE_AFTER_MS after it started,
// by the database clock, oldest first (NS-143). Such a claim belongs to a run that died: it holds
// its ATS lane (AtsBusy) until something closes it. Reads only; the sweep in packages/gateways
// closes each one through recordNeedsHuman.
export async function listStaleClaims(db: Db, candidateId: CandidateId): Promise<SubmissionView[]> {
  return db.transaction(async (tx) => {
    const now = await gateNow(tx);
    const cutoff = new Date(now.getTime() - CLAIM_STALE_AFTER_MS);
    const rows = await tx
      .select()
      .from(applySubmission)
      .where(
        and(
          eq(applySubmission.candidateId, candidateId),
          eq(applySubmission.status, "in_progress"),
          sql`${applySubmission.startedAt} <= ${cutoff.toISOString()}`,
        ),
      )
      .orderBy(applySubmission.startedAt);
    return rows.map(toView);
  });
}
