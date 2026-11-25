import { createHash, randomUUID } from "node:crypto";
import {
  type CandidateId,
  type ConsentPolicy,
  DEFAULT_CONSENT_POLICY,
  decideConsent,
  err,
  type NoticeKind,
  ok,
  parseDomainEvent,
  type Result,
} from "@northstar/domain";
import { isSpanContextValid, type Span } from "@opentelemetry/api";
import { and, desc, eq } from "drizzle-orm";
import { gateNow, inSpan } from "./apply-write.js";
import { consentPolicy, consentRecord, MAX_NOTICE_TEXT } from "./consent-schema.js";
import type { Db } from "./db.js";
import { domainEvent } from "./schema.js";
import { employerTenant } from "./tenant-schema.js";

// The consent policy and accepted notices (NS-124, ACC-008): the one write path for both tables.
// Events carry the policy, the notice kind and the text's SHA-256: never its text or URL.

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const HTTPS_URL = /^https:\/\/[^\s]+$/;

async function appendEvent(
  tx: Tx,
  span: Span,
  input: {
    candidateId: CandidateId;
    aggregate: string;
    type: "consent.policy_set" | "consent.recorded";
    actor: "user" | "agent:apply";
    payload: Record<string, unknown>;
    at: Date;
  },
): Promise<void> {
  const context = span.spanContext();
  const parsed = parseDomainEvent({
    id: randomUUID(),
    candidateId: input.candidateId,
    aggregate: input.aggregate,
    type: input.type,
    actor: input.actor,
    reason: "",
    inputsSummary: "",
    payload: input.payload,
    links: [],
    traceId: isSpanContextValid(context) ? context.traceId : null,
    // Each row is written once, so its own id names the event.
    idempotencyKey: input.aggregate,
    occurredAt: input.at,
  });
  if (!parsed.ok) throw new Error(`invalid consent event: ${parsed.error.fields.join(", ")}`);
  await tx.insert(domainEvent).values(parsed.value);
}

// Paul's current choice, or `auto` (ACC-008's default) until he makes one.
export async function readConsentPolicy(db: Db, candidateId: CandidateId): Promise<ConsentPolicy> {
  const [row] = await db
    .select({ policy: consentPolicy.policy })
    .from(consentPolicy)
    .where(eq(consentPolicy.candidateId, candidateId))
    .orderBy(desc(consentPolicy.position))
    .limit(1);
  return (row?.policy as ConsentPolicy | undefined) ?? DEFAULT_CONSENT_POLICY;
}

// Paul changes his setting: always his (actor `user`).
export async function setConsentPolicy(
  db: Db,
  input: { candidateId: CandidateId; policy: ConsentPolicy },
): Promise<Result<{ policy: ConsentPolicy }, never>> {
  return inSpan("db.consent.policy_set", { "northstar.consent.policy": input.policy }, (span) =>
    db.transaction(async (tx) => {
      const now = await gateNow(tx);
      const [row] = await tx
        .insert(consentPolicy)
        .values({ candidateId: input.candidateId, policy: input.policy, setAt: now })
        .returning({ id: consentPolicy.id });
      if (!row) throw new Error("consent_policy insert returned no row");
      await appendEvent(tx, span, {
        candidateId: input.candidateId,
        aggregate: `consent_policy:${row.id}`,
        type: "consent.policy_set",
        actor: "user",
        payload: { policy: input.policy },
        at: now,
      });
      return ok({ policy: input.policy });
    }),
  );
}

export type ConsentError =
  | { kind: "MarketingRefused" }
  | { kind: "InvalidNotice" }
  | { kind: "NotFound" };

// Records a notice accepted for Paul on a tenant, with its exact text. A marketing opt-in is
// refused here (and by the database): it is always declined, whatever the policy. The caller
// decides with decideConsent first; this only keeps the record.
export async function recordConsent(
  db: Db,
  input: {
    candidateId: CandidateId;
    tenantKey: string;
    kind: NoticeKind;
    noticeUrl: string;
    text: string;
  },
): Promise<Result<{ recordId: string; textSha256: string }, ConsentError>> {
  if (decideConsent(DEFAULT_CONSENT_POLICY, input.kind) === "decline") {
    return err({ kind: "MarketingRefused" });
  }
  const validUrl = input.noticeUrl.length <= 2048 && HTTPS_URL.test(input.noticeUrl);
  const validText = input.text.length >= 1 && input.text.length <= MAX_NOTICE_TEXT;
  if (!validUrl || !validText) return err({ kind: "InvalidNotice" });
  const textSha256 = createHash("sha256").update(input.text, "utf8").digest("hex");
  return inSpan("db.consent.record", { "northstar.consent.kind": input.kind }, (span) =>
    db.transaction(
      async (tx): Promise<Result<{ recordId: string; textSha256: string }, ConsentError>> => {
        const [tenant] = await tx
          .select({ id: employerTenant.id })
          .from(employerTenant)
          .where(
            and(
              eq(employerTenant.candidateId, input.candidateId),
              eq(employerTenant.tenantKey, input.tenantKey),
            ),
          );
        if (!tenant) return err({ kind: "NotFound" });
        const now = await gateNow(tx);
        const [row] = await tx
          .insert(consentRecord)
          .values({
            candidateId: input.candidateId,
            tenantId: tenant.id,
            kind: input.kind,
            noticeUrl: input.noticeUrl,
            textSha256,
            text: input.text,
            acceptedAt: now,
          })
          .returning({ id: consentRecord.id });
        if (!row) throw new Error("consent_record insert returned no row");
        await appendEvent(tx, span, {
          candidateId: input.candidateId,
          aggregate: `consent_record:${row.id}`,
          type: "consent.recorded",
          actor: "agent:apply",
          payload: { tenantKey: input.tenantKey, kind: input.kind, textSha256 },
          at: now,
        });
        return ok({ recordId: row.id, textSha256 });
      },
    ),
  );
}
