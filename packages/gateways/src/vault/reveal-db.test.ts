import { randomBytes } from "node:crypto";
import type { Db } from "@northstar/db";
import { createTestDb, seedApplication, setGateClock } from "@northstar/db/testing";
import { CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbVaultPorts } from "../apply/ports.js";
import * as gateways from "../index.js";
import { masterKeyFrom } from "./key.js";
import { dbRevealPorts, revealTenantPassword } from "./reveal.js";
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

const reveal = (key = KEY, tenantKey = TENANT) =>
  revealTenantPassword(dbRevealPorts(db), key, { candidateId, tenantKey });

describe("revealTenantPassword", () => {
  it("decrypts the tenant's newest password, every time it is asked", async () => {
    const first = await reveal();
    const second = await reveal();
    expect([first.ok && first.value.reveal(), second.ok && second.value.reveal()]).toEqual([
      "test-Reveal-Pass-7!",
      "test-Reveal-Pass-7!",
    ]);
  });

  it("names the refusal and decrypts nothing for a tenant with no password", async () => {
    expect(await reveal(KEY, "workday:globex")).toEqual({
      ok: false,
      error: { kind: "SecretNotFound" },
    });
  });

  it("says the key is wrong rather than returning garbage", async () => {
    expect(await reveal(masterKeyFrom(randomBytes(32)))).toEqual({
      ok: false,
      error: { kind: "VaultKeyMismatch" },
    });
  });

  it("is the package's only exported way to open the vault", () => {
    const openers = Object.entries(gateways)
      .filter(([n, v]) => typeof v === "function" && /open|reveal|decrypt|password/i.test(n))
      .map(([n]) => n);
    expect(openers.sort()).toEqual([
      "dbRevealPorts",
      "generateTenantPassword",
      "revealTenantPassword",
      "storeTenantPassword",
    ]);
  });
});
