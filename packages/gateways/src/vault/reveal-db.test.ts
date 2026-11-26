import { randomBytes, randomUUID } from "node:crypto";
import { type Db, decideApprovals, requestApproval } from "@northstar/db";
import { createTestDb, seedApplication, setGateClock } from "@northstar/db/testing";
import { CandidateId, revealContentSha256 } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbVaultPorts } from "../apply/ports.js";
import * as gateways from "../index.js";
import { masterKeyFrom } from "./key.js";
import { revealTenantPassword } from "./reveal.js";
import { VaultSecret } from "./secret.js";
import { storeTenantPassword } from "./store.js";

// Revealing a password to Paul (NS-182, ADR-0024) end to end on the real write paths (PGlite).
// Synthetic passwords only.

const KEY = masterKeyFrom(randomBytes(32));
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
  await storeTenantPassword(dbVaultPorts(db), KEY, {
    candidateId,
    tenantKey: TENANT,
    actor: "agent:apply",
    password: new VaultSecret("test-Reveal-Pass-7!"),
  });
});

afterEach(async () => {
  await close();
});

// Paul's approval of a request of this kind and content, at NOW (no clock move: a reveal takes
// effect at once, an application approval doesn't).
async function approved(kind: "vault_reveal" | "application_package"): Promise<string> {
  const requested = await requestApproval(db, {
    candidateId,
    kind,
    subject: `${kind}:${randomUUID()}`,
    contentSha256: kind === "vault_reveal" ? revealContentSha256(TENANT) : "c".repeat(64),
    facts: null,
    actor: "system",
    idempotencyKey: randomUUID(),
  });
  if (!requested.ok) throw new Error(requested.error.kind);
  const decided = await decideApprovals(db, {
    candidateId,
    requestIds: [requested.value.requestId],
    decision: "approve",
  });
  const outcome = decided.ok ? decided.value[0]?.result : undefined;
  if (!outcome?.ok) throw new Error("not approved");
  return outcome.value.decisionId;
}

const reveal = (decisionId: string) =>
  revealTenantPassword(dbVaultPorts(db), KEY, { candidateId, tenantKey: TENANT, decisionId });

describe("revealTenantPassword", () => {
  it("decrypts the password under Paul's reveal approval, once", async () => {
    const decisionId = await approved("vault_reveal");
    const first = await reveal(decisionId);
    const second = await reveal(decisionId);
    expect([first.ok && first.value.reveal(), second]).toEqual([
      "test-Reveal-Pass-7!",
      { ok: false, error: { kind: "NotApproved" } },
    ]);
  });

  it("can't reveal under an application approval, even one that has taken effect", async () => {
    const decisionId = await approved("application_package");
    await setGateClock(db, new Date(NOW.getTime() + 10 * 60 * 1000));
    expect(await reveal(decisionId)).toEqual({ ok: false, error: { kind: "NotApproved" } });
  });

  it("is the package's only exported way to open the vault", () => {
    const openers = Object.entries(gateways)
      .filter(([n, v]) => typeof v === "function" && /open|reveal|decrypt|password/i.test(n))
      .map(([n]) => n);
    expect(openers.sort()).toEqual([
      "generateTenantPassword",
      "revealTenantPassword",
      "storeTenantPassword",
    ]);
  });
});
