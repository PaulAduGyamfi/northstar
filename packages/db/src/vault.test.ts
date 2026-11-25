import { randomBytes, randomUUID } from "node:crypto";
import { CandidateId, UNDO_WINDOW_MS } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideApprovals, requestApproval, undoDecision } from "./approval-write.js";
import type { Db } from "./db.js";
import { setKillSwitch } from "./kill-switch-write.js";
import { domainEvent } from "./schema.js";
import { createTestDb, seedApplication, setGateClock, sqlState } from "./test/pglite.js";
import { vaultAccess, vaultSecret } from "./vault-schema.js";
import { openSealedSecret, type SealedSecret, storeSealedSecret } from "./vault-write.js";

// The vault's write path on PGlite. The bytes here are random stand-ins of the right sizes:
// sealing and opening are packages/gateways' job and are tested there.

const RESTRICT_VIOLATION = "23001";
const NOW = new Date("2026-11-25T12:00:00Z");
const PAST_UNDO = new Date(NOW.getTime() + UNDO_WINDOW_MS);

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "awaiting_approval");
  candidateId = CandidateId.parse(seeded.candidateId);
  await setGateClock(db, NOW);
});

afterEach(async () => {
  await close();
});

const sealed = (): SealedSecret => ({
  masterKeyId: "a".repeat(64),
  wrappedKeyIv: randomBytes(12),
  wrappedKey: randomBytes(32),
  wrappedKeyTag: randomBytes(16),
  iv: randomBytes(12),
  ciphertext: randomBytes(20),
  tag: randomBytes(16),
});

const store = (tenantKey = "workday:acme") =>
  storeSealedSecret(db, { candidateId, tenantKey, actor: "agent:apply", sealed: sealed() });

// A Gate decision by Paul at NOW. By default an approval, with the clock moved past its undo
// window so it has taken effect.
async function decision(
  how: { decide?: "approve" | "reject"; pastUndoWindow?: boolean } = {},
): Promise<string> {
  await setGateClock(db, NOW);
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
  const decide = how.decide ?? "approve";
  const decided = await decideApprovals(db, {
    candidateId,
    requestIds: [requested.value.requestId],
    decision: decide,
    ...(decide === "reject" ? { reason: "Not this one" } : {}),
  });
  const outcome = decided.ok ? decided.value[0]?.result : undefined;
  if (!outcome?.ok) throw new Error("not decided");
  if (how.pastUndoWindow ?? true) await setGateClock(db, PAST_UNDO);
  return outcome.value.decisionId;
}

const open = async (decisionId: string, tenantKey = "workday:acme") =>
  openSealedSecret(db, {
    candidateId,
    tenantKey,
    actor: "agent:apply",
    purpose: "sign_in",
    decisionId,
  });

describe("storeSealedSecret", () => {
  it("stores version 1, then version 2 on rotation", async () => {
    const first = await store();
    const second = await store();
    expect([first.ok && first.value.version, second.ok && second.value.version]).toEqual([1, 2]);
  });

  it("numbers each tenant's versions on their own", async () => {
    await store("workday:acme");
    const other = await store("workday:globex");
    expect(other.ok && other.value.version).toBe(1);
  });

  it("refuses a tenant key outside the vocabulary", async () => {
    expect(await store("Acme Corp")).toEqual({
      ok: false,
      error: { kind: "InvalidVaultInput", field: "tenantKey" },
    });
  });

  it("writes a stored event with the tenant and version only", async () => {
    const stored = await store();
    const [event] = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.type, "vault_secret.stored"));
    expect([event?.aggregate, event?.payload]).toEqual([
      `vault_secret:${stored.ok && stored.value.secretId}`,
      { tenant: "workday:acme", version: 1 },
    ]);
  });
});

describe("openSealedSecret", () => {
  it("returns the newest version's sealed bytes", async () => {
    await store();
    const second = await store();
    const opened = await open(await decision());
    const [row] = await db
      .select()
      .from(vaultSecret)
      .where(eq(vaultSecret.id, second.ok ? second.value.secretId : ""));
    expect([
      opened.ok && opened.value.version,
      opened.ok && Buffer.from(opened.value.ciphertext).equals(Buffer.from(row?.ciphertext ?? [])),
    ]).toEqual([2, true]);
  });

  it("records who opened it, why and under which decision (CRD-003)", async () => {
    const stored = await store();
    const decisionId = await decision();
    await open(decisionId);
    const rows = await db
      .select({
        secretId: vaultAccess.secretId,
        actor: vaultAccess.actor,
        purpose: vaultAccess.purpose,
        decisionId: vaultAccess.decisionId,
      })
      .from(vaultAccess);
    expect(rows).toEqual([
      {
        secretId: stored.ok ? stored.value.secretId : "",
        actor: "agent:apply",
        purpose: "sign_in",
        decisionId,
      },
    ]);
  });

  it("writes an opened event with the tenant, version, purpose and decision only", async () => {
    await store();
    const decisionId = await decision();
    await open(decisionId);
    const [event] = await db.select().from(domainEvent).where(eq(domainEvent.type, "vault.opened"));
    expect(event?.payload).toEqual({
      tenant: "workday:acme",
      version: 1,
      purpose: "sign_in",
      decisionId,
    });
  });

  it.each([
    ["the Gate never made", async () => randomUUID()],
    ["Paul rejected", async () => decision({ decide: "reject" })],
    ["is still inside its undo window", async () => decision({ pastUndoWindow: false })],
    [
      "Paul undid",
      async () => {
        const id = await decision({ pastUndoWindow: false });
        const undone = await undoDecision(db, { candidateId, decisionId: id });
        if (!undone.ok) throw new Error(undone.error.kind);
        await setGateClock(db, PAST_UNDO);
        return id;
      },
    ],
  ])("is NotApproved under a decision %s, and records nothing", async (_what, make) => {
    await store();
    const decisionId = await make();
    const opened = await open(decisionId);
    const rows = await db.select().from(vaultAccess);
    expect([opened, rows.length]).toEqual([{ ok: false, error: { kind: "NotApproved" } }, 0]);
  });

  it("is VaultLocked while the vault kill switch is off, and records nothing (CRD-005)", async () => {
    await store();
    const decisionId = await decision();
    await setKillSwitch(db, {
      candidateId,
      subsystem: "vault",
      enabled: false,
      actor: "user",
      reason: "Lost my laptop",
    });
    const opened = await open(decisionId);
    const rows = await db.select().from(vaultAccess);
    expect([opened, rows.length]).toEqual([{ ok: false, error: { kind: "VaultLocked" } }, 0]);
  });

  it("opens again once the vault is unlocked", async () => {
    await store();
    const decisionId = await decision();
    const lock = { candidateId, subsystem: "vault", actor: "user" as const, reason: "Check" };
    await setKillSwitch(db, { ...lock, enabled: false });
    await setKillSwitch(db, { ...lock, enabled: true });
    expect((await open(decisionId)).ok).toBe(true);
  });

  it("is SecretNotFound for a tenant with nothing stored", async () => {
    expect(await open(await decision(), "workday:initech")).toEqual({
      ok: false,
      error: { kind: "SecretNotFound" },
    });
  });

  it("refuses a free-text purpose", async () => {
    await store();
    const opened = await openSealedSecret(db, {
      candidateId,
      tenantKey: "workday:acme",
      actor: "agent:apply",
      purpose: "Sign in please",
      decisionId: await decision(),
    });
    expect(opened).toEqual({ ok: false, error: { kind: "InvalidVaultInput", field: "purpose" } });
  });
});

describe("vault tables", () => {
  it("refuse changing a stored secret", async () => {
    await store();
    expect(await sqlState(db.update(vaultSecret).set({ version: 9 }))).toBe(RESTRICT_VIOLATION);
  });

  it("refuse deleting a stored secret", async () => {
    await store();
    expect(await sqlState(db.delete(vaultSecret))).toBe(RESTRICT_VIOLATION);
  });

  it("refuse emptying the access log", async () => {
    await store();
    await open(await decision());
    expect(await sqlState(db.delete(vaultAccess))).toBe(RESTRICT_VIOLATION);
    expect(await sqlState(db.execute(sql`truncate vault_access`))).toBe(RESTRICT_VIOLATION);
  });

  it("refuse a sealed row with the wrong IV size, in an error with no sealed bytes", async () => {
    const bad = { ...sealed(), iv: randomBytes(8) };
    const message = await storeSealedSecret(db, {
      candidateId,
      tenantKey: "workday:acme",
      actor: "agent:apply",
      sealed: bad,
    }).then(
      () => "stored",
      (error: Error) => `${error.message}|${String(error.cause ?? "")}`,
    );
    expect(message).toBe("db.vault.store failed|");
  });

  it("refuse emptying the secrets", async () => {
    await store();
    // A plain truncate is already refused because vault_access references the table; cascade
    // gets past that, so this reaches the append-only triggers.
    expect(await sqlState(db.execute(sql`truncate vault_secret cascade`))).toBe(RESTRICT_VIOLATION);
  });

  it("refuse changing an access record", async () => {
    await store();
    await open(await decision());
    expect(await sqlState(db.update(vaultAccess).set({ purpose: "other" }))).toBe(
      RESTRICT_VIOLATION,
    );
  });

  it("keep sealed bytes out of the event log", async () => {
    await store();
    await open(await decision());
    const [row] = await db.select().from(vaultSecret);
    const events = await db.select({ payload: domainEvent.payload }).from(domainEvent);
    const text = JSON.stringify(events);
    const bytes = Buffer.from(row?.ciphertext ?? []);
    expect([text.includes(bytes.toString("base64")), text.includes(bytes.toString("hex"))]).toEqual(
      [false, false],
    );
  });
});
