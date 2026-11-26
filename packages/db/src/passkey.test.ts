import { CandidateId } from "@northstar/domain";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { passkeyCredential, passkeyUse } from "./passkey-schema.js";
import { listPasskeys, readPasskey, recordPasskeyUse, savePasskey } from "./passkey-write.js";
import { candidate, domainEvent } from "./schema.js";
import { createTestDb, sqlState } from "./test/pglite.js";

// Paul's passkeys (NS-178, ADR-0022). Synthetic credential ids and key bytes only.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

async function newCandidate(): Promise<CandidateId> {
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  return CandidateId.parse(c.id);
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  candidateId = await newCandidate();
});

afterEach(async () => {
  await close();
});

const CRED = "c3ludGhldGljLWNyZWRlbnRpYWwtMQ";
const passkey = (overrides: Partial<Parameters<typeof savePasskey>[1]> = {}) => ({
  candidateId,
  credentialId: CRED,
  publicKey: new Uint8Array([1, 2, 3, 4]),
  signCount: 0,
  transports: ["internal"],
  ...overrides,
});

async function saved(overrides: Partial<Parameters<typeof savePasskey>[1]> = {}): Promise<string> {
  const result = await savePasskey(db, passkey(overrides));
  if (!result.ok) throw new Error(result.error.kind);
  return result.value.passkeyId;
}

describe("savePasskey", () => {
  it("stores a passkey and reads it back with its key and count", async () => {
    const passkeyId = await saved({ signCount: 7 });
    expect(await readPasskey(db, candidateId, CRED)).toEqual({
      passkeyId,
      credentialId: CRED,
      publicKey: new Uint8Array([1, 2, 3, 4]),
      signCount: 7,
      transports: ["internal"],
    });
  });

  it("refuses a credential id that is already registered", async () => {
    await saved();
    const again = await savePasskey(db, passkey());
    expect(again.ok ? "saved" : again.error.kind).toBe("AlreadyRegistered");
  });

  it("writes one passkey.registered event with the row id and nothing about the key", async () => {
    const passkeyId = await saved();
    const events = await db.select().from(domainEvent);
    expect(events.map((e) => [e.type, e.payload, e.reason])).toEqual([
      ["passkey.registered", { passkeyId }, "A passkey was added"],
    ]);
  });

  it("refuses a credential id that isn't base64url, in the database", async () => {
    expect(await sqlState(savePasskey(db, passkey({ credentialId: "not base64url!" })))).toBe(
      CHECK_VIOLATION,
    );
  });
});

describe("listPasskeys and readPasskey", () => {
  it("lists only the given candidate's passkeys", async () => {
    await saved();
    const other = await newCandidate();
    await saved({ candidateId: other, credentialId: "c3ludGhldGljLWNyZWRlbnRpYWwtMg" });
    expect(await listPasskeys(db, candidateId)).toEqual([
      { credentialId: CRED, transports: ["internal"] },
    ]);
  });

  it("finds no passkey under another candidate", async () => {
    await saved();
    expect(await readPasskey(db, await newCandidate(), CRED)).toBe(null);
  });
});

describe("recordPasskeyUse", () => {
  it("moves the sign count forward", async () => {
    const id = await saved({ signCount: 3 });
    const used = await recordPasskeyUse(db, candidateId, id, 4);
    expect([used.ok, (await readPasskey(db, candidateId, CRED))?.signCount]).toEqual([true, 4]);
  });

  it("refuses a count that doesn't increase", async () => {
    const id = await saved({ signCount: 3 });
    await recordPasskeyUse(db, candidateId, id, 5);
    const results = await Promise.all([
      recordPasskeyUse(db, candidateId, id, 5),
      recordPasskeyUse(db, candidateId, id, 4),
    ]);
    expect(results.map((r) => (r.ok ? "ok" : r.error.kind))).toEqual([
      "SignCountNotIncreased",
      "SignCountNotIncreased",
    ]);
  });

  it("accepts a count that stays at 0, as platform passkeys report", async () => {
    const id = await saved({ signCount: 0 });
    const results = [
      await recordPasskeyUse(db, candidateId, id, 0),
      await recordPasskeyUse(db, candidateId, id, 0),
    ];
    expect(results.map((r) => r.ok)).toEqual([true, true]);
  });

  it("refuses 0 once a passkey has counted up", async () => {
    const id = await saved({ signCount: 2 });
    const used = await recordPasskeyUse(db, candidateId, id, 0);
    expect(used.ok ? "ok" : used.error.kind).toBe("SignCountNotIncreased");
  });

  it("refuses a passkey of another candidate", async () => {
    const id = await saved();
    const used = await recordPasskeyUse(db, await newCandidate(), id, 1);
    expect(used.ok ? "ok" : used.error.kind).toBe("NotFound");
  });
});

describe("database guards", () => {
  it("refuses editing or deleting a passkey or a use", async () => {
    const id = await saved();
    await recordPasskeyUse(db, candidateId, id, 1);
    expect([
      await sqlState(db.update(passkeyCredential).set({ signCount: 99 })),
      await sqlState(db.delete(passkeyCredential).where(eq(passkeyCredential.id, id))),
      await sqlState(db.update(passkeyUse).set({ signCount: 99 })),
      await sqlState(db.delete(passkeyUse)),
    ]).toEqual([RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION]);
  });

  it("refuses two uses with the same non-zero count, even written directly", async () => {
    const id = await saved();
    await recordPasskeyUse(db, candidateId, id, 1);
    expect(
      await sqlState(db.insert(passkeyUse).values({ candidateId, passkeyId: id, signCount: 1 })),
    ).toBe("23505");
  });
});
