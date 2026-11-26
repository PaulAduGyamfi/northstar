import { randomBytes, randomUUID } from "node:crypto";
import { CandidateId, revealContentSha256, UNDO_WINDOW_MS } from "@northstar/domain";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decideApprovals,
  requestApproval,
  undoDecision,
  withdrawApproval,
} from "./approval-write.js";
import type { Db } from "./db.js";
import { setKillSwitch } from "./kill-switch-write.js";
import { createTestDb, seedApplication, setGateClock, sqlState } from "./test/pglite.js";
import { vaultAccess } from "./vault-schema.js";
import {
  type OpenInput,
  openSealedSecret,
  type SealedSecret,
  storeSealedSecret,
} from "./vault-write.js";

// Revealing a vault password to Paul (NS-182, ADR-0024) on PGlite: a `vault_reveal` approval
// takes effect at once and opens one tenant's newest secret once. Random stand-in bytes only.

const CHECK_VIOLATION = "23514";
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
  for (const tenantKey of [TENANT, "workday:globex"]) {
    await storeSealedSecret(db, { candidateId, tenantKey, actor: "agent:apply", sealed: sealed() });
  }
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

// A request of the given kind, decided by Paul at NOW. Returns the request and decision ids.
async function decided(
  how: {
    kind?: "vault_reveal" | "application_package";
    tenantKey?: string;
    decide?: "approve" | "reject";
  } = {},
): Promise<{ requestId: string; decisionId: string; effectiveAt: Date }> {
  const kind = how.kind ?? "vault_reveal";
  const requested = await requestApproval(db, {
    candidateId,
    kind,
    subject: `${kind}:${randomUUID()}`,
    contentSha256:
      kind === "vault_reveal" ? revealContentSha256(how.tenantKey ?? TENANT) : "c".repeat(64),
    facts: null,
    actor: kind === "vault_reveal" ? "system" : "agent:apply",
    idempotencyKey: randomUUID(),
  });
  if (!requested.ok) throw new Error(requested.error.kind);
  const decide = how.decide ?? "approve";
  const result = await decideApprovals(db, {
    candidateId,
    requestIds: [requested.value.requestId],
    decision: decide,
    ...(decide === "reject" ? { reason: "Not now" } : {}),
  });
  const outcome = result.ok ? result.value[0]?.result : undefined;
  if (!outcome?.ok) throw new Error("not decided");
  return {
    requestId: requested.value.requestId,
    decisionId: outcome.value.decisionId,
    effectiveAt: outcome.value.effectiveAt,
  };
}

const reveal = (decisionId: string, over: Partial<OpenInput> = {}) =>
  openSealedSecret(db, {
    candidateId,
    tenantKey: TENANT,
    actor: "user",
    purpose: "reveal_to_user",
    decisionId,
    ...over,
  });

const kindOf = (r: { ok: boolean; error?: { kind: string } }) => (r.ok ? "ok" : r.error?.kind);

describe("a vault_reveal approval", () => {
  it("takes effect at once, while an application approval still waits for its undo window", async () => {
    const rev = await decided();
    const app = await decided({ kind: "application_package" });
    expect([
      rev.effectiveAt.getTime() - NOW.getTime(),
      app.effectiveAt.getTime() - NOW.getTime(),
    ]).toEqual([0, UNDO_WINDOW_MS]);
  });

  it("can't be undone, because it has no undo window", async () => {
    const rev = await decided();
    expect(await undoDecision(db, { candidateId, decisionId: rev.decisionId })).toEqual({
      ok: false,
      error: { kind: "UndoWindowClosed" },
    });
  });
});

describe("revealing a password", () => {
  it("opens the tenant's newest secret once and records one access by Paul", async () => {
    const { decisionId } = await decided();
    const first = await reveal(decisionId);
    const second = await reveal(decisionId);
    const rows = await db
      .select({ actor: vaultAccess.actor, purpose: vaultAccess.purpose })
      .from(vaultAccess)
      .where(eq(vaultAccess.decisionId, decisionId));
    expect([first.ok && first.value.tenantKey, kindOf(second), rows]).toEqual([
      TENANT,
      "NotApproved",
      [{ actor: "user", purpose: "reveal_to_user" }],
    ]);
  });

  it("refuses a reveal approved for another tenant", async () => {
    const { decisionId } = await decided({ tenantKey: "workday:globex" });
    expect(kindOf(await reveal(decisionId))).toBe("NotApproved");
  });

  it("refuses an application approval as the authority for a reveal", async () => {
    const { decisionId } = await decided({ kind: "application_package" });
    await setGateClock(db, new Date(NOW.getTime() + UNDO_WINDOW_MS));
    expect(kindOf(await reveal(decisionId))).toBe("NotApproved");
  });

  it("refuses a rejected reveal and a withdrawn one", async () => {
    const rejected = await decided({ decide: "reject" });
    const approved = await decided();
    const withdrawn = await withdrawApproval(db, {
      candidateId,
      requestId: approved.requestId,
      by: "user",
    });
    expect([
      kindOf(await reveal(rejected.decisionId)),
      withdrawn.ok,
      kindOf(await reveal(approved.decisionId)),
    ]).toEqual(["NotApproved", true, "NotApproved"]);
  });

  it("is VaultLocked while the vault is switched off, and records nothing", async () => {
    const { decisionId } = await decided();
    await setKillSwitch(db, {
      candidateId,
      subsystem: "vault",
      enabled: false,
      actor: "user",
      reason: "Locked",
    });
    const rows = await db.select().from(vaultAccess);
    expect([kindOf(await reveal(decisionId)), rows.length]).toEqual(["VaultLocked", 0]);
  });
});

describe("who may reveal", () => {
  it("a reveal approval opens nothing for an agent's purpose", async () => {
    const { decisionId } = await decided();
    expect(kindOf(await reveal(decisionId, { actor: "agent:apply", purpose: "sign_in" }))).toBe(
      "NotApproved",
    );
  });

  it("Paul's actor can use no purpose but a reveal, and an agent can't reveal", async () => {
    const { decisionId } = await decided();
    expect([
      await reveal(decisionId, { purpose: "sign_in" }),
      await reveal(decisionId, { actor: "agent:apply" }),
    ]).toEqual([
      { ok: false, error: { kind: "InvalidVaultInput", field: "purpose" } },
      { ok: false, error: { kind: "InvalidVaultInput", field: "actor" } },
    ]);
  });

  it("the database refuses an access row that pairs Paul with an agent's purpose", async () => {
    const { decisionId } = await decided();
    const stored = await storeSealedSecret(db, {
      candidateId,
      tenantKey: "workday:initech",
      actor: "agent:apply",
      sealed: sealed(),
    });
    const attempt = db.insert(vaultAccess).values({
      candidateId,
      secretId: stored.ok ? stored.value.secretId : "",
      actor: "user",
      purpose: "sign_in",
      decisionId,
    });
    expect(await sqlState(attempt)).toBe(CHECK_VIOLATION);
  });
});
