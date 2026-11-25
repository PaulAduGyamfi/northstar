import { randomBytes } from "node:crypto";
import {
  type Db,
  decideApprovals,
  requestApproval,
  schema,
  setKillSwitch,
  vaultAccess,
} from "@northstar/db";
import { createTestDb, seedApplication, setGateClock } from "@northstar/db/testing";
import { CandidateId, UNDO_WINDOW_MS } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbVaultPorts } from "../apply/ports.js";
import { keyBytes, masterKeyFrom } from "./key.js";
import { useTenantPassword } from "./open.js";
import { VaultSecret } from "./secret.js";
import { generateTenantPassword, storeTenantPassword } from "./store.js";

// The vault end to end on the real write paths (PGlite): store, rotate, open under a Gate
// decision, the lock, and that nothing secret reaches the event log.

const KEY = masterKeyFrom(randomBytes(32));
const NOW = new Date("2026-11-25T12:00:00Z");

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

async function decision(): Promise<string> {
  const requested = await requestApproval(db, {
    candidateId,
    kind: "application_package",
    subject: "application_package:11111111-1111-4111-8111-111111111111",
    contentSha256: "c".repeat(64),
    facts: null,
    actor: "agent:apply",
    idempotencyKey: "test:vault",
  });
  if (!requested.ok) throw new Error(requested.error.kind);
  const decided = await decideApprovals(db, {
    candidateId,
    requestIds: [requested.value.requestId],
    decision: "approve",
  });
  const outcome = decided.ok ? decided.value[0]?.result : undefined;
  if (!outcome?.ok) throw new Error("not approved");
  // Past the undo window, so the approval has taken effect.
  await setGateClock(db, new Date(NOW.getTime() + UNDO_WINDOW_MS));
  return outcome.value.decisionId;
}

const store = (password: VaultSecret) =>
  storeTenantPassword(dbVaultPorts(db), KEY, {
    candidateId,
    tenantKey: "workday:acme",
    actor: "agent:apply",
    password,
  });

const use = async () =>
  useTenantPassword(dbVaultPorts(db), KEY, {
    candidateId,
    tenantKey: "workday:acme",
    actor: "agent:apply",
    purpose: "sign_in",
    decisionId: await decision(),
  });

describe("the vault on the real write paths", () => {
  it("gives back the newest password after a rotation", async () => {
    await store(new VaultSecret("test-old-Pass1!"));
    const rotated = generateTenantPassword();
    await store(rotated);
    const opened = await use();
    expect(opened.ok && opened.value.reveal()).toBe(rotated.reveal());
  });

  it("refuses with VaultLocked while the vault is locked, and decrypts nothing", async () => {
    await store(new VaultSecret("test-Pass1!"));
    await setKillSwitch(db, {
      candidateId,
      subsystem: "vault",
      enabled: false,
      actor: "user",
      reason: "Lock vault",
    });
    expect(await use()).toEqual({ ok: false, error: { kind: "VaultLocked" } });
  });

  it("records the access even when the key can't open the row", async () => {
    await store(new VaultSecret("test-Pass1!"));
    const opened = await useTenantPassword(dbVaultPorts(db), masterKeyFrom(randomBytes(32)), {
      candidateId,
      tenantKey: "workday:acme",
      actor: "agent:apply",
      purpose: "sign_in",
      decisionId: await decision(),
    });
    const access = await db.select().from(vaultAccess);
    expect([opened, access.length]).toEqual([
      { ok: false, error: { kind: "VaultKeyMismatch" } },
      1,
    ]);
  });

  it("puts no password or key in the event log (sealed bytes: packages/db)", async () => {
    const password = new VaultSecret("test-Unique-Pass-93!");
    await store(password);
    await use();
    const events = await db.select().from(schema.domainEvent);
    // Event positions are bigints, which JSON can't hold; write them as strings.
    const text = JSON.stringify(events, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect([
      text.includes(password.reveal()),
      text.includes(Buffer.from(keyBytes(KEY)).toString("base64")),
      text.includes(Buffer.from(keyBytes(KEY)).toString("hex")),
    ]).toEqual([false, false, false]);
  });
});

describe("useTenantPassword under a decision that isn't a live approval", () => {
  it("is NotApproved inside the undo window, and decrypts nothing", async () => {
    await store(new VaultSecret("test-Pass1!"));
    const id = await decision();
    // Back to the moment of approval: the undo window is still open.
    await setGateClock(db, NOW);
    const opened = await useTenantPassword(dbVaultPorts(db), KEY, {
      candidateId,
      tenantKey: "workday:acme",
      actor: "agent:apply",
      purpose: "sign_in",
      decisionId: id,
    });
    expect(opened).toEqual({ ok: false, error: { kind: "NotApproved" } });
  });
});
