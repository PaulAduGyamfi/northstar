import { randomUUID } from "node:crypto";
import {
  type ApplyAts,
  type CandidateId,
  err,
  type NeedsHumanReason,
  ok,
  parseDomainEvent,
  type Result,
} from "@northstar/domain";
import { isSpanContextValid, type Span } from "@opentelemetry/api";
import { and, asc, eq, isNull } from "drizzle-orm";
import { applySubmission } from "./apply-schema.js";
import { gateNow, inSpan } from "./apply-write.js";
import type { Db } from "./db.js";
import { applyHandoff, applyHandoffDone, type HandoffOutcome } from "./handoff-schema.js";
import { application, domainEvent } from "./schema.js";

// Human handoffs (NS-121, APPLY-006, ACC-007): the one write path for apply_handoff and
// apply_handoff_done. A handoff is opened inside recordNeedsHuman's transaction (apply-write.ts);
// Paul resolves it here. Events carry ids, the ATS, the reason and the outcome: never the URL.

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// The link a handoff can hold: the same rule as apply_handoff's CHECKs (https, no whitespace,
// at most 2048 characters). The package schema accepts more, so it is checked here first.
const MAX_URL_LENGTH = 2048;
const HANDOFF_URL = /^https:\/\/[^\s]+$/;
// The link as the handoff stores it (`new URL` lower-cases the scheme and host and encodes
// spaces), or null when it still can't be held.
function holdable(url: string): string | null {
  let href: string;
  try {
    href = new URL(url).href;
  } catch {
    return null;
  }
  return href.length <= MAX_URL_LENGTH && HANDOFF_URL.test(href) ? href : null;
}

// The reasons only Paul's hands can get past (ADR-0003): a handoff is opened for these alone.
export const CHALLENGE_REASONS: readonly NeedsHumanReason[] = [
  "captcha",
  "login",
  "mfa",
  "account",
];

export type HandoffView = {
  handoffId: string;
  submissionId: string;
  applicationId: string;
  ats: ApplyAts;
  reason: NeedsHumanReason;
  applyUrl: string;
  createdAt: Date;
};

async function appendEvent(
  tx: Tx,
  span: Span,
  candidateId: CandidateId,
  handoffId: string,
  what: "opened" | "resolved" | "prefilled",
  payload: Record<string, unknown>,
  at: Date,
  // A pre-fill can happen once per grant, so its key carries the grant's key too (NS-192).
  keySuffix = "",
  // The feed line for a type with no template in feed.ts: fixed words only (db.md).
  reason = "",
): Promise<void> {
  const context = span.spanContext();
  const parsed = parseDomainEvent({
    id: randomUUID(),
    candidateId,
    aggregate: `apply_handoff:${handoffId}`,
    type: `handoff.${what}`,
    actor: what === "opened" ? "agent:apply" : "user",
    reason,
    inputsSummary: "",
    payload,
    links: [],
    traceId: isSpanContextValid(context) ? context.traceId : null,
    idempotencyKey: `apply_handoff:${handoffId}:${what}${keySuffix}`,
    occurredAt: at,
  });
  // Every field is built here, so a bad event is a bug, not an input error.
  if (!parsed.ok) throw new Error(`invalid handoff event: ${parsed.error.fields.join(", ")}`);
  // Only a pre-fill may repeat its key (a retry of the same serve), and then stores nothing; a
  // repeated opened or resolved event is still an error, as before.
  if (what !== "prefilled") {
    await tx.insert(domainEvent).values(parsed.value);
    return;
  }
  await tx
    .insert(domainEvent)
    .values(parsed.value)
    .onConflictDoNothing({ target: [domainEvent.candidateId, domainEvent.idempotencyKey] });
}

// Opens a handoff for a submission just marked needs_human, in the caller's transaction. Only
// for a challenge reason with an apply URL; anything else opens nothing.
export async function openHandoff(
  tx: Tx,
  span: Span,
  input: {
    candidateId: CandidateId;
    submissionId: string;
    applicationId: string;
    ats: string;
    reason: NeedsHumanReason;
    applyUrl: string | undefined;
    now: Date;
  },
): Promise<void> {
  if (input.applyUrl === undefined || !CHALLENGE_REASONS.includes(input.reason)) return;
  // A link the table would refuse opens no handoff rather than failing needs_human itself: the
  // submission must still free its ATS lane and show up as needs_human (fail small, RES-*).
  const applyUrl = holdable(input.applyUrl);
  if (applyUrl === null) {
    span.setAttribute("northstar.apply.handoff_skipped", "unholdable_url");
    return;
  }
  const [row] = await tx
    .insert(applyHandoff)
    .values({
      candidateId: input.candidateId,
      submissionId: input.submissionId,
      applyUrl,
      createdAt: input.now,
    })
    .returning({ id: applyHandoff.id });
  if (!row) throw new Error("apply_handoff insert returned no row");
  span.setAttribute("northstar.apply.handoff", true);
  await appendEvent(
    tx,
    span,
    input.candidateId,
    row.id,
    "opened",
    {
      submissionId: input.submissionId,
      applicationId: input.applicationId,
      ats: input.ats,
      reason: input.reason,
    },
    input.now,
  );
}

// Paul's open handoffs, oldest first, with the page to open.
export async function listOpenHandoffs(db: Db, candidateId: CandidateId): Promise<HandoffView[]> {
  const rows = await db
    .select({
      handoffId: applyHandoff.id,
      submissionId: applyHandoff.submissionId,
      applicationId: applySubmission.applicationId,
      ats: applySubmission.ats,
      reason: applySubmission.reason,
      applyUrl: applyHandoff.applyUrl,
      createdAt: applyHandoff.createdAt,
    })
    .from(applyHandoff)
    .innerJoin(applySubmission, eq(applySubmission.id, applyHandoff.submissionId))
    .leftJoin(applyHandoffDone, eq(applyHandoffDone.handoffId, applyHandoff.id))
    .where(and(eq(applyHandoff.candidateId, candidateId), isNull(applyHandoffDone.id)))
    .orderBy(asc(applyHandoff.createdAt), asc(applyHandoff.id));
  return rows.map((r) => ({
    ...r,
    ats: r.ats as ApplyAts,
    reason: r.reason as NeedsHumanReason,
  }));
}

export type Resolved = { applicationId: string; outcome: HandoffOutcome; replayed: boolean };
export type ResolveError = { kind: "NotFound" } | { kind: "NotNeedsHuman" };

// Records what Paul did with a handoff, once. A second call returns the first outcome and
// writes nothing, so a retried click is safe (RES-006).
export async function resolveHandoff(
  db: Db,
  input: { candidateId: CandidateId; handoffId: string; outcome: HandoffOutcome },
): Promise<Result<Resolved, ResolveError>> {
  return inSpan(
    "db.apply.handoff_resolve",
    { "northstar.handoff.outcome": input.outcome },
    (span) =>
      db.transaction(async (tx) => {
        const [h] = await tx
          .select({ id: applyHandoff.id, applicationId: applySubmission.applicationId })
          .from(applyHandoff)
          .innerJoin(applySubmission, eq(applySubmission.id, applyHandoff.submissionId))
          .where(
            and(
              eq(applyHandoff.id, input.handoffId),
              eq(applyHandoff.candidateId, input.candidateId),
            ),
          )
          .for("update", { of: applyHandoff });
        if (!h) return err({ kind: "NotFound" as const });
        const [done] = await tx
          .select({ outcome: applyHandoffDone.outcome })
          .from(applyHandoffDone)
          .where(eq(applyHandoffDone.handoffId, h.id));
        if (done) {
          const outcome = done.outcome as HandoffOutcome;
          return ok({ applicationId: h.applicationId, outcome, replayed: true });
        }
        // "Submitted" is stored only while the application still waits in needs_human (its row
        // locked), so the move that follows can't be refused for a status that changed and
        // leave a closed handoff with nothing on screen to retry it.
        if (input.outcome === "submitted") {
          const [app] = await tx
            .select({ status: application.status })
            .from(application)
            .where(eq(application.id, h.applicationId))
            .for("update");
          if (app?.status !== "needs_human") return err({ kind: "NotNeedsHuman" as const });
        }
        const now = await gateNow(tx);
        await tx.insert(applyHandoffDone).values({
          candidateId: input.candidateId,
          handoffId: h.id,
          outcome: input.outcome,
          doneAt: now,
        });
        await appendEvent(
          tx,
          span,
          input.candidateId,
          h.id,
          "resolved",
          { applicationId: h.applicationId, outcome: input.outcome },
          now,
        );
        return ok({ applicationId: h.applicationId, outcome: input.outcome, replayed: false });
      }),
  );
}

// The ATS names in fixed words, for the feed line of a pre-fill.
const ATS_WORDS: Record<ApplyAts, string> = {
  greenhouse: "a Greenhouse",
  lever: "a Lever",
  ashby: "an Ashby",
  smartrecruiters: "a SmartRecruiters",
};

// handoff.prefilled's feed line: its `reason`, built only from fixed words (no template in feed.ts).
export function prefillReason(ats: ApplyAts): string {
  return `Pre-filled ${ATS_WORDS[ats] ?? "a"} form for you to finish`;
}

// A grant's key: 16 lowercase hex characters (the first of its SHA-256, from apps/api).
const GRANT_KEY = /^[0-9a-f]{16}$/;

// The extension was handed one open handoff's approved package to pre-fill (NS-192 slice 3,
// ADR-0029): `handoff.prefilled` with ids, the ATS and the package's field count, never a value.
// Paul's click issued the grant, so the actor is `user`. Keyed per grant, so a retry of the same
// serve stores one event. The handoff must be the candidate's own.
export async function recordHandoffPrefill(
  db: Db,
  input: {
    candidateId: CandidateId;
    handoffId: string;
    applicationId: string;
    ats: ApplyAts;
    fieldCount: number;
    grantKey: string;
  },
): Promise<Result<{ recorded: true }, { kind: "NotFound" } | { kind: "InvalidInput" }>> {
  return inSpan("db.apply.handoff_prefilled", { "northstar.handoff.ats": input.ats }, (span) =>
    db.transaction(async (tx) => {
      if (!GRANT_KEY.test(input.grantKey) || !Number.isInteger(input.fieldCount)) {
        return err({ kind: "InvalidInput" as const });
      }
      if (input.fieldCount < 0 || input.fieldCount > 200) {
        return err({ kind: "InvalidInput" as const });
      }
      // The candidate's own handoff, for this very application (through its submission), so the
      // event's payload can't name another application.
      const [h] = await tx
        .select({ id: applyHandoff.id })
        .from(applyHandoff)
        .innerJoin(applySubmission, eq(applySubmission.id, applyHandoff.submissionId))
        .where(
          and(
            eq(applyHandoff.id, input.handoffId),
            eq(applyHandoff.candidateId, input.candidateId),
            eq(applySubmission.applicationId, input.applicationId),
          ),
        );
      if (!h) return err({ kind: "NotFound" as const });
      await appendEvent(
        tx,
        span,
        input.candidateId,
        h.id,
        "prefilled",
        { applicationId: input.applicationId, ats: input.ats, fieldCount: input.fieldCount },
        await gateNow(tx),
        `:${input.grantKey}`,
        prefillReason(input.ats),
      );
      return ok({ recorded: true as const });
    }),
  );
}
