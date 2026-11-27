import { randomBytes, randomUUID } from "node:crypto";
import { CandidateId, revealContentSha256, UNDO_WINDOW_MS } from "@northstar/domain";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approvalDecision, approvalRequest, approvalWithdrawal } from "./approval-schema.js";
import {
  decideApprovals,
  listPendingApprovals,
  requestApproval,
  undoDecision,
  withdrawApproval,
} from "./approval-write.js";
import type { Db } from "./db.js";
import { setKillSwitch } from "./kill-switch-write.js";
import { domainEvent } from "./schema.js";
import { createTestDb, seedApplication, setGateClock, sqlState } from "./test/pglite.js";
import { vaultAccess } from "./vault-schema.js";
import {
  openSealedSecret,
  revealSealedSecret,
  type SealedSecret,
  storeSealedSecret,
} from "./vault-write.js";

// Revealing a vault password to Paul (NS-182, ADR-0024) on PGlite: revealSealedSecret files,
// approves and uses a one-time `vault_reveal` in one transaction. Random stand-in bytes only.

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const NOW = new Date("2026-11-26T09:00:00Z");
const TENANT = "workday:acme";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "awaiting_approval");
  candidateId = CandidateId.parse(seeded.candidateId);
  await setGateClock(db, NOW);
  await storeSealedSecret(db, {
    candidateId,
    tenantKey: TENANT,
    actor: "agent:apply",
    sealed: sealed(),
  });
});

afterEach(async () => {
  await close();
});

function sealed(): SealedSecret {
  return {
    masterKeyId: "a".repeat(64),
    wrappedKeyIv: randomBytes(12),
    wrappedKey: randomBytes(32),
    wrappedKeyTag: randomBytes(16),
    iv: randomBytes(12),
    ciphertext: randomBytes(20),
    tag: randomBytes(16),
  };
}

const reveal = (tenantKey = TENANT) => revealSealedSecret(db, { candidateId, tenantKey });

// The one reveal decision written so far, with its request.
async function revealDecision() {
  const [row] = await db
    .select({
      decisionId: approvalDecision.id,
      decidedBy: approvalDecision.decidedBy,
      decision: approvalDecision.decision,
      decidedAt: approvalDecision.decidedAt,
      effectiveAt: approvalDecision.effectiveAt,
      actor: approvalRequest.actor,
      contentSha256: approvalRequest.contentSha256,
    })
    .from(approvalDecision)
    .innerJoin(approvalRequest, eq(approvalRequest.id, approvalDecision.requestId))
    .where(eq(approvalRequest.kind, "vault_reveal"));
  if (!row) throw new Error("no reveal decision");
  return row;
}

describe("revealSealedSecret", () => {
  it("files a reveal by system, approved by Paul, effective at once, for this tenant", async () => {
    const result = await reveal();
    const d = await revealDecision();
    expect([
      result.ok && result.value.tenantKey,
      d.actor,
      d.decidedBy,
      d.decision,
      d.effectiveAt.getTime() - d.decidedAt.getTime(),
      d.contentSha256 === revealContentSha256(TENANT),
    ]).toEqual([TENANT, "system", "user", "approved", 0, true]);
  });

  it("records one access by Paul under that decision, with a vault.opened event", async () => {
    await reveal();
    const { decisionId } = await revealDecision();
    const access = await db
      .select({ actor: vaultAccess.actor, purpose: vaultAccess.purpose })
      .from(vaultAccess)
      .where(eq(vaultAccess.decisionId, decisionId));
    const opened = await db
      .select({ payload: domainEvent.payload })
      .from(domainEvent)
      .where(eq(domainEvent.type, "vault.opened"));
    expect([access, opened.map((e) => e.payload.purpose)]).toEqual([
      [{ actor: "user", purpose: "reveal_to_user" }],
      ["reveal_to_user"],
    ]);
  });

  it("makes a new approval for every reveal, so each one is audited on its own", async () => {
    await reveal();
    await reveal();
    const requests = await db
      .select({ id: approvalRequest.id })
      .from(approvalRequest)
      .where(eq(approvalRequest.kind, "vault_reveal"));
    const access = await db.select().from(vaultAccess);
    expect([requests.length, access.length]).toEqual([2, 2]);
  });

  it("is VaultLocked while the vault is switched off, and files nothing", async () => {
    await setKillSwitch(db, {
      candidateId,
      subsystem: "vault",
      enabled: false,
      actor: "user",
      reason: "Locked",
    });
    const result = await reveal();
    const requests = await db.select().from(approvalRequest);
    expect([result, requests.length]).toEqual([{ ok: false, error: { kind: "VaultLocked" } }, 0]);
  });

  it("is SecretNotFound for a tenant with nothing stored, and files nothing", async () => {
    const result = await reveal("workday:globex");
    const requests = await db.select().from(approvalRequest);
    expect([result, requests.length]).toEqual([
      { ok: false, error: { kind: "SecretNotFound" } },
      0,
    ]);
  });
});

describe("a reveal can't be made or reused any other way", () => {
  it("the Gate refuses a vault_reveal request from anyone", async () => {
    const requested = await requestApproval(db, {
      candidateId,
      kind: "vault_reveal",
      subject: `vault_reveal:${randomUUID()}`,
      contentSha256: revealContentSha256(TENANT),
      facts: null,
      actor: "agent:apply",
      idempotencyKey: randomUUID(),
    });
    expect(requested).toEqual({ ok: false, error: { kind: "InvalidRequest", fields: ["kind"] } });
  });

  it("a reveal never waits in the queue and can't be decided or undone from it", async () => {
    await reveal();
    const { decisionId } = await revealDecision();
    const [request] = await db.select({ id: approvalRequest.id }).from(approvalRequest);
    const decided = await decideApprovals(db, {
      candidateId,
      requestIds: [request?.id ?? ""],
      decision: "reject",
      reason: "No",
    });
    expect([
      await listPendingApprovals(db, candidateId),
      decided.ok && decided.value[0]?.result,
      await undoDecision(db, { candidateId, decisionId }),
    ]).toEqual([
      [],
      { ok: false, error: { kind: "NotFound" } },
      { ok: false, error: { kind: "UndoWindowClosed" } },
    ]);
  });

  it("openSealedSecret opens nothing under a reveal decision, for any actor or purpose", async () => {
    await reveal();
    const { decisionId } = await revealDecision();
    const open = (actor: string, purpose: string) =>
      openSealedSecret(db, { candidateId, tenantKey: TENANT, actor, purpose, decisionId });
    await setGateClock(db, new Date(NOW.getTime() + UNDO_WINDOW_MS));
    expect([
      await open("agent:apply", "sign_in"),
      await open("agent:apply", "reveal_to_user"),
      await open("user", "reveal_to_user"),
    ]).toEqual([
      { ok: false, error: { kind: "NotApproved" } },
      { ok: false, error: { kind: "InvalidVaultInput", field: "purpose" } },
      { ok: false, error: { kind: "InvalidVaultInput", field: "actor" } },
    ]);
  });

  it("the database refuses a second reveal access under one decision", async () => {
    const revealed = await reveal();
    const { decisionId } = await revealDecision();
    const again = db.insert(vaultAccess).values({
      candidateId,
      secretId: revealed.ok ? revealed.value.secretId : "",
      actor: "user",
      purpose: "reveal_to_user",
      decisionId,
    });
    expect(await sqlState(again)).toBe(UNIQUE_VIOLATION);
  });

  it("the database refuses an access that pairs Paul with an agent's purpose", async () => {
    const revealed = await reveal();
    const { decisionId } = await revealDecision();
    const attempt = db.insert(vaultAccess).values({
      candidateId,
      secretId: revealed.ok ? revealed.value.secretId : "",
      actor: "user",
      purpose: "sign_in",
      decisionId,
    });
    expect(await sqlState(attempt)).toBe(CHECK_VIOLATION);
  });

  // NS-246 slice 2 (migration 0095): the reveal's database guards.
  it("the database refuses an agent's access under a reveal decision", async () => {
    const revealed = await reveal();
    const { decisionId } = await revealDecision();
    const attempt = db.insert(vaultAccess).values({
      candidateId,
      secretId: revealed.ok ? revealed.value.secretId : "",
      actor: "agent:apply",
      purpose: "sign_in",
      decisionId,
    });
    expect(await sqlState(attempt)).toBe(CHECK_VIOLATION);
  });

  it("the database refuses a reveal under any approval but a reveal's own", async () => {
    const revealed = await reveal();
    const requested = await requestApproval(db, {
      candidateId,
      kind: "application_package",
      subject: `application_package:${randomUUID()}`,
      contentSha256: "c".repeat(64),
      facts: null,
      actor: "agent:apply",
      idempotencyKey: randomUUID(),
    });
    if (!requested.ok) throw new Error(requested.error.kind);
    const decided = await decideApprovals(db, {
      candidateId,
      requestIds: [requested.value.requestId],
      decision: "approve",
    });
    const first = decided.ok ? decided.value[0]?.result : undefined;
    const decisionId = first?.ok ? first.value.decisionId : "";
    const attempt = db.insert(vaultAccess).values({
      candidateId,
      secretId: revealed.ok ? revealed.value.secretId : "",
      actor: "user",
      purpose: "reveal_to_user",
      decisionId,
    });
    expect(await sqlState(attempt)).toBe(CHECK_VIOLATION);
  });

  it("nobody withdraws a reveal: withdrawApproval answers NotFound and the database refuses it", async () => {
    await reveal();
    const [request] = await db
      .select({ id: approvalRequest.id })
      .from(approvalRequest)
      .where(eq(approvalRequest.kind, "vault_reveal"));
    const requestId = request?.id ?? "";
    await setGateClock(db, new Date(NOW.getTime() + UNDO_WINDOW_MS));
    expect([
      await withdrawApproval(db, { candidateId, requestId, by: "user" }),
      await withdrawApproval(db, {
        candidateId,
        requestId,
        by: "gateway",
        newContentSha256: "d".repeat(64),
      }),
      await withdrawApproval(db, { candidateId, requestId, by: "system" }),
    ]).toEqual([
      { ok: false, error: { kind: "NotFound" } },
      { ok: false, error: { kind: "NotFound" } },
      { ok: false, error: { kind: "NotFound" } },
    ]);
    const direct = db.insert(approvalWithdrawal).values({
      candidateId,
      requestId,
      withdrawnBy: "user",
      reason: "paul",
      withdrawnAt: NOW,
    });
    expect(await sqlState(direct)).toBe(CHECK_VIOLATION);
  });

  it("an application approval still waits out its undo window", async () => {
    const requested = await requestApproval(db, {
      candidateId,
      kind: "application_package",
      subject: `application_package:${randomUUID()}`,
      contentSha256: "c".repeat(64),
      facts: null,
      actor: "agent:apply",
      idempotencyKey: randomUUID(),
    });
    if (!requested.ok) throw new Error(requested.error.kind);
    const decided = await decideApprovals(db, {
      candidateId,
      requestIds: [requested.value.requestId],
      decision: "approve",
    });
    const first = decided.ok ? decided.value[0]?.result : undefined;
    const view = first?.ok ? first.value : null;
    expect(view && view.effectiveAt.getTime() - view.decidedAt.getTime()).toBe(UNDO_WINDOW_MS);
  });
});
