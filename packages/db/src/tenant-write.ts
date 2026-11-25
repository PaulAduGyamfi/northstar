import { randomUUID } from "node:crypto";
import {
  type AccountStatus,
  type CandidateId,
  err,
  type IllegalAccountMove,
  nextAccountStatus,
  ok,
  parseDomainEvent,
  type Result,
} from "@northstar/domain";
import { isSpanContextValid, type Span } from "@opentelemetry/api";
import { and, asc, eq } from "drizzle-orm";
import { gateNow, inSpan } from "./apply-write.js";
import type { Db } from "./db.js";
import { domainEvent } from "./schema.js";
import { ACCOUNT_REASON_PATTERN, employerTenant, tenantAccountStatus } from "./tenant-schema.js";
import { TENANT_KEY_PATTERN } from "./vault-schema.js";

// The tenant registry's one write path (NS-124, ACC-001, ACC-006). Events carry the tenant key,
// ATS, statuses and reason codes: never the account email or tenant URL.

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type AccountActor = "user" | "agent:apply";

const TENANT_KEY = new RegExp(TENANT_KEY_PATTERN);
const REASON = new RegExp(ACCOUNT_REASON_PATTERN);
// The same rules as employer_tenant's CHECKs, checked first so a bad input is a value, not a throw.
const HTTPS_URL = /^https:\/\/[^\s]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

export type TenantView = {
  tenantKey: string;
  ats: string;
  status: AccountStatus;
  createdAt: Date;
  // When the status last changed, or null while it has never left `none`.
  changedAt: Date | null;
};

async function appendEvent(
  tx: Tx,
  span: Span,
  input: {
    candidateId: CandidateId;
    tenantId: string;
    type: "tenant.registered" | "tenant.account_changed";
    actor: AccountActor;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    at: Date;
  },
): Promise<void> {
  const context = span.spanContext();
  const parsed = parseDomainEvent({
    id: randomUUID(),
    candidateId: input.candidateId,
    aggregate: `employer_tenant:${input.tenantId}`,
    type: input.type,
    actor: input.actor,
    reason: "",
    inputsSummary: "",
    payload: input.payload,
    links: [],
    traceId: isSpanContextValid(context) ? context.traceId : null,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.at,
  });
  // Every field is built here, so a bad event is a bug, not an input error.
  if (!parsed.ok) throw new Error(`invalid tenant event: ${parsed.error.fields.join(", ")}`);
  await tx.insert(domainEvent).values(parsed.value);
}

// The tenant's row, locked so status moves on it run one at a time (the ACC-006 guard).
async function lockTenant(tx: Tx, candidateId: CandidateId, tenantKey: string) {
  const [t] = await tx
    .select({ id: employerTenant.id, ats: employerTenant.ats })
    .from(employerTenant)
    .where(
      and(eq(employerTenant.candidateId, candidateId), eq(employerTenant.tenantKey, tenantKey)),
    )
    .for("update");
  return t;
}

async function currentStatus(tx: Tx, tenantId: string): Promise<AccountStatus> {
  const rows = await tx
    .select({ to: tenantAccountStatus.toStatus })
    .from(tenantAccountStatus)
    .where(eq(tenantAccountStatus.tenantId, tenantId))
    .orderBy(asc(tenantAccountStatus.position));
  return (rows.at(-1)?.to as AccountStatus | undefined) ?? "none";
}

// Registers a tenant once. A second call returns the existing row, whatever URL or email it
// carries: a tenant's details are fixed once its account may exist.
export async function registerTenant(
  db: Db,
  input: { candidateId: CandidateId; tenantKey: string; tenantUrl: string; accountEmail: string },
): Promise<Result<{ tenantId: string; created: boolean }, { kind: "InvalidTenant" }>> {
  const validKey = TENANT_KEY.test(input.tenantKey);
  const validUrl = input.tenantUrl.length <= 2048 && HTTPS_URL.test(input.tenantUrl);
  const validEmail = input.accountEmail.length <= 320 && EMAIL.test(input.accountEmail);
  if (!validKey || !validUrl || !validEmail) return err({ kind: "InvalidTenant" });
  const ats = input.tenantKey.split(":")[0] as string;
  return inSpan("db.tenant.register", { "northstar.tenant.key": input.tenantKey }, (span) =>
    db.transaction(async (tx) => {
      const now = await gateNow(tx);
      const [row] = await tx
        .insert(employerTenant)
        .values({
          candidateId: input.candidateId,
          tenantKey: input.tenantKey,
          ats,
          tenantUrl: input.tenantUrl,
          accountEmail: input.accountEmail,
          createdAt: now,
        })
        .onConflictDoNothing({ target: [employerTenant.candidateId, employerTenant.tenantKey] })
        .returning({ id: employerTenant.id });
      if (!row) {
        const existing = await lockTenant(tx, input.candidateId, input.tenantKey);
        if (!existing) throw new Error("employer_tenant conflict without a row");
        return ok({ tenantId: existing.id, created: false });
      }
      await appendEvent(tx, span, {
        candidateId: input.candidateId,
        tenantId: row.id,
        type: "tenant.registered",
        actor: "agent:apply",
        payload: { tenantKey: input.tenantKey, ats },
        idempotencyKey: `employer_tenant:${row.id}:registered`,
        at: now,
      });
      return ok({ tenantId: row.id, created: true });
    }),
  );
}

export type MoveError =
  | { kind: "NotFound" }
  | { kind: "InvalidReason" }
  | { kind: "StaleStatus"; expected: AccountStatus; actual: AccountStatus }
  | IllegalAccountMove;

// Moves a tenant's account from `from` to `to`, only if `from` is still current and the state
// machine allows it (packages/domain, tenant-account.ts).
export async function moveAccount(
  db: Db,
  input: {
    candidateId: CandidateId;
    tenantKey: string;
    from: AccountStatus;
    to: AccountStatus;
    reason: string;
    actor: AccountActor;
  },
): Promise<Result<{ status: AccountStatus }, MoveError>> {
  if (!REASON.test(input.reason)) return err({ kind: "InvalidReason" });
  const allowed = nextAccountStatus(input.from, input.to);
  if (!allowed.ok) return allowed;
  return inSpan(
    "db.tenant.move",
    { "northstar.tenant.key": input.tenantKey, "northstar.tenant.to": input.to },
    (span) =>
      db.transaction(async (tx): Promise<Result<{ status: AccountStatus }, MoveError>> => {
        const tenant = await lockTenant(tx, input.candidateId, input.tenantKey);
        if (!tenant) return err({ kind: "NotFound" });
        const actual = await currentStatus(tx, tenant.id);
        if (actual !== input.from) {
          return err({ kind: "StaleStatus", expected: input.from, actual });
        }
        const now = await gateNow(tx);
        const [row] = await tx
          .insert(tenantAccountStatus)
          .values({
            candidateId: input.candidateId,
            tenantId: tenant.id,
            fromStatus: input.from,
            toStatus: input.to,
            reason: input.reason,
            actor: input.actor,
            changedAt: now,
          })
          .returning({ id: tenantAccountStatus.id });
        if (!row) throw new Error("tenant_account_status insert returned no row");
        await appendEvent(tx, span, {
          candidateId: input.candidateId,
          tenantId: tenant.id,
          type: "tenant.account_changed",
          actor: input.actor,
          payload: {
            tenantKey: input.tenantKey,
            ats: tenant.ats,
            from: input.from,
            to: input.to,
            reason: input.reason,
          },
          idempotencyKey: `tenant_account_status:${row.id}`,
          at: now,
        });
        return ok({ status: input.to });
      }),
  );
}

// ACC-006: the only way to start creating an account. Of any number of callers, one moves the
// tenant from `none` to `creating`; every other gets AlreadyStarted with the current status, so
// it signs in or waits instead of creating a second account.
export async function beginAccountCreation(
  db: Db,
  input: { candidateId: CandidateId; tenantKey: string; actor: AccountActor },
): Promise<
  Result<
    { status: "creating" },
    { kind: "NotFound" } | { kind: "AlreadyStarted"; status: AccountStatus }
  >
> {
  const moved = await moveAccount(db, {
    ...input,
    from: "none",
    to: "creating",
    reason: "started",
  });
  if (moved.ok) return ok({ status: "creating" });
  if (moved.error.kind === "StaleStatus") {
    return err({ kind: "AlreadyStarted", status: moved.error.actual });
  }
  if (moved.error.kind === "NotFound") return err({ kind: "NotFound" });
  // "started" is a valid reason and none → creating is allowed, so nothing else can happen.
  throw new Error(`beginAccountCreation: ${moved.error.kind}`);
}

// Paul's tenants, oldest first, with each one's current status. A handful of rows per tenant, so
// the newest is picked here rather than in SQL.
export async function listTenants(db: Db, candidateId: CandidateId): Promise<TenantView[]> {
  const tenants = await db
    .select({
      id: employerTenant.id,
      tenantKey: employerTenant.tenantKey,
      ats: employerTenant.ats,
      createdAt: employerTenant.createdAt,
    })
    .from(employerTenant)
    .where(eq(employerTenant.candidateId, candidateId))
    .orderBy(asc(employerTenant.createdAt), asc(employerTenant.tenantKey));
  const moves = await db
    .select({
      tenantId: tenantAccountStatus.tenantId,
      to: tenantAccountStatus.toStatus,
      at: tenantAccountStatus.changedAt,
    })
    .from(tenantAccountStatus)
    .where(eq(tenantAccountStatus.candidateId, candidateId))
    .orderBy(asc(tenantAccountStatus.position));
  const latest = new Map<string, { to: string; at: Date }>();
  for (const m of moves) latest.set(m.tenantId, m);
  return tenants.map((t) => {
    const last = latest.get(t.id);
    return {
      tenantKey: t.tenantKey,
      ats: t.ats,
      status: (last?.to as AccountStatus | undefined) ?? "none",
      createdAt: t.createdAt,
      changedAt: last?.at ?? null,
    };
  });
}
