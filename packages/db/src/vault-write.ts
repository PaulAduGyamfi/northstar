import { randomUUID } from "node:crypto";
import {
  type CandidateId,
  err,
  ok,
  parseDomainEvent,
  type Result,
  revealContentSha256,
} from "@northstar/domain";
import { isSpanContextValid, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  approvalDecision,
  approvalRequest,
  approvalUndo,
  approvalWithdrawal,
} from "./approval-schema.js";
import type { Db } from "./db.js";
import { currentState } from "./kill-switch-write.js";
import { domainEvent } from "./schema.js";
import { TENANT_KEY_PATTERN, vaultAccess, vaultSecret } from "./vault-schema.js";

// The credential vault's one write path (NS-122, ADR-0010). It stores and hands out sealed rows
// only: no plaintext or key ever reaches this package. Events and spans carry the tenant key,
// versions, ids and a purpose code, never a byte of the sealed row.

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// The kill switch that locks the vault (CRD-005, RES-008).
export const VAULT_SUBSYSTEM = "vault";

const TENANT_KEY = new RegExp(TENANT_KEY_PATTERN);
const ACTOR = /^agent:[a-z0-9-]+$/;
const PURPOSE = /^[a-z]+(_[a-z]+)*$/;
// Paul reveals one of his own passwords (NS-182, ADR-0024): the only purpose actor `user` may
// use, and the only purpose a `vault_reveal` approval opens anything for.
export const REVEAL_PURPOSE = "reveal_to_user";
export const REVEAL_ACTOR = "user";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// What packages/gateways seals: an envelope, never the secret.
export type SealedSecret = {
  masterKeyId: string;
  wrappedKeyIv: Uint8Array;
  wrappedKey: Uint8Array;
  wrappedKeyTag: Uint8Array;
  iv: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
};

export type SealedVersion = SealedSecret & { secretId: string; tenantKey: string; version: number };

export type InvalidVaultInput = { kind: "InvalidVaultInput"; field: string };
export type VaultLocked = { kind: "VaultLocked" };
export type SecretNotFound = { kind: "SecretNotFound" };
// The decision id isn't a live approval of this candidate: unknown, rejected, undone, or still
// inside its undo window (ADR-0010 item 2: decrypt only under an approval or policy decision).
export type NotApproved = { kind: "NotApproved" };

const tracer = () => trace.getTracer("@northstar/db");

// Runs fn in a span tagged with the tenant key; marks it with the refusal kind or "DatabaseError".
async function inSpan<T, E extends { kind: string }>(
  name: string,
  tenantKey: string,
  fn: (span: Span) => Promise<Result<T, E>>,
): Promise<Result<T, E>> {
  return tracer().startActiveSpan(name, async (span) => {
    span.setAttribute("northstar.vault.tenant", tenantKey);
    try {
      const result = await fn(span);
      span.setAttribute("northstar.vault.outcome", result.ok ? "ok" : result.error.kind);
      if (!result.ok) span.setStatus({ code: SpanStatusCode.ERROR, message: result.error.kind });
      return result;
    } catch {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "DatabaseError" });
      // A fresh error with no cause: the driver's message lists the query's parameters, which
      // here are sealed bytes. They are useless without the key, but never leave this package.
      throw new Error(`${name} failed`);
    } finally {
      span.end();
    }
  });
}

async function appendEvent(
  tx: Tx,
  span: Span,
  e: {
    candidateId: CandidateId;
    secretId: string;
    type: "vault_secret.stored" | "vault.opened";
    actor: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  },
): Promise<void> {
  const context = span.spanContext();
  const parsed = parseDomainEvent({
    id: randomUUID(),
    candidateId: e.candidateId,
    aggregate: `vault_secret:${e.secretId}`,
    type: e.type,
    actor: e.actor,
    reason: "",
    inputsSummary: "",
    payload: e.payload,
    links: [],
    traceId: isSpanContextValid(context) ? context.traceId : null,
    idempotencyKey: e.idempotencyKey,
    occurredAt: new Date(),
  });
  // Every field is built here from checked values, so a bad event is a bug.
  if (!parsed.ok) throw new Error(`invalid vault event: ${parsed.error.fields.join(", ")}`);
  await tx.insert(domainEvent).values(parsed.value);
}

// Stores a new version of a tenant's secret (create or rotate): the next version number under a
// per-tenant lock, so two rotations can't both claim the same version.
export async function storeSealedSecret(
  db: Db,
  input: { candidateId: CandidateId; tenantKey: string; actor: string; sealed: SealedSecret },
): Promise<Result<{ secretId: string; version: number }, InvalidVaultInput>> {
  if (!TENANT_KEY.test(input.tenantKey)) {
    return err({ kind: "InvalidVaultInput", field: "tenantKey" });
  }
  if (!ACTOR.test(input.actor)) return err({ kind: "InvalidVaultInput", field: "actor" });
  return inSpan("db.vault.store", input.tenantKey, (span) =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`vault:${input.candidateId}:${input.tenantKey}`}))`,
      );
      const [latest] = await tx
        .select({ version: vaultSecret.version })
        .from(vaultSecret)
        .where(
          and(
            eq(vaultSecret.candidateId, input.candidateId),
            eq(vaultSecret.tenantKey, input.tenantKey),
          ),
        )
        .orderBy(desc(vaultSecret.version))
        .limit(1);
      const version = (latest?.version ?? 0) + 1;
      const [row] = await tx
        .insert(vaultSecret)
        .values({
          candidateId: input.candidateId,
          tenantKey: input.tenantKey,
          version,
          ...input.sealed,
        })
        .returning({ id: vaultSecret.id });
      if (!row) throw new Error("vault_secret insert returned no row");
      await appendEvent(tx, span, {
        candidateId: input.candidateId,
        secretId: row.id,
        type: "vault_secret.stored",
        actor: input.actor,
        payload: { tenant: input.tenantKey, version },
        idempotencyKey: `vault_secret:${row.id}:stored`,
      });
      return ok({ secretId: row.id, version });
    }),
  );
}

export type OpenInput = {
  candidateId: CandidateId;
  tenantKey: string;
  // `agent:<name>`: the code asking; or `user` for Paul's own reveal (purpose `reveal_to_user`).
  actor: string;
  // A fixed code such as `sign_in` or `create_account`.
  purpose: string;
  // The approvalId or policyDecisionId this acts under; a foreign key, so it must exist.
  decisionId: string;
};

// Is this an approval of this candidate that has taken effect and wasn't undone or withdrawn? By the Gate's
// clock (northstar_gate_now()), as verifyApproval decides it. The caller still verifies the
// decision covers the action at hand; this keeps a rejected or undone id from opening anything.
async function liveApproval(
  tx: Tx,
  candidateId: CandidateId,
  decisionId: string,
): Promise<boolean> {
  if (!UUID.test(decisionId)) return false;
  // Lock the decision row first, as verifyApproval does: a withdrawal (NS-140) locks it too, so
  // an opening and a withdrawal never overlap; whichever commits first, the other sees it.
  await tx
    .select({ id: approvalDecision.id })
    .from(approvalDecision)
    .where(and(eq(approvalDecision.id, decisionId), eq(approvalDecision.candidateId, candidateId)))
    .for("update");
  const [row] = await tx
    .select({ id: approvalDecision.id })
    .from(approvalDecision)
    .leftJoin(approvalUndo, eq(approvalUndo.decisionId, approvalDecision.id))
    .where(
      and(
        eq(approvalDecision.id, decisionId),
        eq(approvalDecision.candidateId, candidateId),
        eq(approvalDecision.decision, "approved"),
        sql`${approvalDecision.effectiveAt} <= northstar_gate_now()`,
        sql`${approvalUndo.id} is null`,
        // A withdrawn request (NS-140) is closed: its approval opens nothing.
        sql`not exists (
          select 1 from ${approvalWithdrawal} w where w.request_id = ${approvalDecision.requestId}
        )`,
      ),
    );
  return row !== undefined;
}

// Does this decision authorize this opening? An agent's purpose needs any live approval but a
// reveal's; a reveal needs Paul's approval of a `vault_reveal` request for this very tenant that
// has opened nothing before (ADR-0024: one passkey check, one tenant, one use). Runs after
// liveApproval, which holds the decision's row lock, so two reveals can't both pass.
async function fitsPurpose(tx: Tx, input: OpenInput): Promise<boolean> {
  const [row] = await tx
    .select({
      kind: approvalRequest.kind,
      contentSha256: approvalRequest.contentSha256,
      decidedBy: approvalDecision.decidedBy,
    })
    .from(approvalDecision)
    .innerJoin(approvalRequest, eq(approvalRequest.id, approvalDecision.requestId))
    .where(
      and(
        eq(approvalDecision.id, input.decisionId),
        eq(approvalDecision.candidateId, input.candidateId),
      ),
    );
  if (!row) return false;
  const isReveal = input.purpose === REVEAL_PURPOSE;
  // A reveal approval never opens anything for an agent, and an agent's approval never reveals.
  if ((row.kind === "vault_reveal") !== isReveal) return false;
  if (!isReveal) return true;
  if (row.decidedBy !== "user") return false;
  if (row.contentSha256 !== revealContentSha256(input.tenantKey)) return false;
  const [used] = await tx
    .select({ id: vaultAccess.id })
    .from(vaultAccess)
    .where(
      and(
        eq(vaultAccess.candidateId, input.candidateId),
        eq(vaultAccess.decisionId, input.decisionId),
      ),
    )
    .limit(1);
  return used === undefined;
}

// Who may ask for which purpose: an agent for its own fixed codes, Paul only to reveal.
function validActorPurpose(input: OpenInput): string | null {
  if (!PURPOSE.test(input.purpose)) return "purpose";
  if (input.actor === REVEAL_ACTOR) return input.purpose === REVEAL_PURPOSE ? null : "purpose";
  if (!ACTOR.test(input.actor)) return "actor";
  return input.purpose === REVEAL_PURPOSE ? "actor" : null;
}

// Hands out the newest sealed version of a tenant's secret for decryption in the Apply Gateway,
// recording the access first, in the same transaction (CRD-003). Refused while the vault is
// locked (CRD-005), before anything is read.
export async function openSealedSecret(
  db: Db,
  input: OpenInput,
): Promise<Result<SealedVersion, InvalidVaultInput | VaultLocked | SecretNotFound | NotApproved>> {
  if (!TENANT_KEY.test(input.tenantKey)) {
    return err({ kind: "InvalidVaultInput", field: "tenantKey" });
  }
  const bad = validActorPurpose(input);
  if (bad !== null) return err({ kind: "InvalidVaultInput", field: bad });
  return inSpan(
    "db.vault.open",
    input.tenantKey,
    (span): Promise<Result<SealedVersion, VaultLocked | SecretNotFound | NotApproved>> =>
      db.transaction(async (tx) => {
        // Shares the lock setKillSwitch takes to flip `vault`, so a lock that commits first is
        // seen here, and one that comes later waits for this open to finish.
        await tx.execute(
          sql`select pg_advisory_xact_lock_shared(hashtext(${`kill_switch:${input.candidateId}:${VAULT_SUBSYSTEM}`}))`,
        );
        if (!(await currentState(tx, input.candidateId, VAULT_SUBSYSTEM))) {
          return err({ kind: "VaultLocked" as const });
        }
        if (!(await liveApproval(tx, input.candidateId, input.decisionId))) {
          return err({ kind: "NotApproved" as const });
        }
        if (!(await fitsPurpose(tx, input))) return err({ kind: "NotApproved" as const });
        const [row] = await tx
          .select()
          .from(vaultSecret)
          .where(
            and(
              eq(vaultSecret.candidateId, input.candidateId),
              eq(vaultSecret.tenantKey, input.tenantKey),
            ),
          )
          .orderBy(desc(vaultSecret.version))
          .limit(1);
        if (!row) return err({ kind: "SecretNotFound" as const });
        const [access] = await tx
          .insert(vaultAccess)
          .values({
            candidateId: input.candidateId,
            secretId: row.id,
            actor: input.actor,
            purpose: input.purpose,
            decisionId: input.decisionId,
          })
          .returning({ id: vaultAccess.id });
        if (!access) throw new Error("vault_access insert returned no row");
        await appendEvent(tx, span, {
          candidateId: input.candidateId,
          secretId: row.id,
          type: "vault.opened",
          actor: input.actor,
          payload: {
            tenant: row.tenantKey,
            version: row.version,
            purpose: input.purpose,
            decisionId: input.decisionId,
          },
          idempotencyKey: `vault_access:${access.id}`,
        });
        return ok({
          secretId: row.id,
          tenantKey: row.tenantKey,
          version: row.version,
          masterKeyId: row.masterKeyId,
          wrappedKeyIv: new Uint8Array(row.wrappedKeyIv),
          wrappedKey: new Uint8Array(row.wrappedKey),
          wrappedKeyTag: new Uint8Array(row.wrappedKeyTag),
          iv: new Uint8Array(row.iv),
          ciphertext: new Uint8Array(row.ciphertext),
          tag: new Uint8Array(row.tag),
        });
      }),
  );
}
