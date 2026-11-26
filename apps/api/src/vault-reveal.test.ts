import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type Db, vaultAccess } from "@northstar/db";
import { createTestDb, seedApplication, setGateClock } from "@northstar/db/testing";
import { CandidateId } from "@northstar/domain";
import {
  dbVaultPorts,
  loadVaultKey,
  type MasterKey,
  storeTenantPassword,
  VaultSecret,
} from "@northstar/gateways";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "./config.js";
import {
  type PasskeyStore,
  passkeyAssertion,
  passkeyEndpoints,
  REVEAL_CHALLENGE_TTL_MS,
} from "./passkeys.js";
import { createApi } from "./server.js";
import { createSessions, type Sessions, THROTTLE_LIMIT } from "./sessions.js";
import { type FakeAuthenticator, fakeAuthenticator } from "./test/authenticator.js";
import { portOf, type Sent, send } from "./test/http.js";
import { REVEALS_PER_MINUTE, vaultRevealEndpoints } from "./vault-reveal.js";

// Paul's password reveal (NS-230, ADR-0024) over a real http server: a fake authenticator, the
// passkey store in memory, and the vault on the real write paths (PGlite). Synthetic password and
// key only.

const HASH = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")
const WEB = "http://northstar.localhost:3100";
const RP_ID = "northstar.localhost";
const TENANT = "workday:acme";
const PASSWORD = "test-Reveal-Pass-7!";

const exporter = new InMemorySpanExporter();
beforeAll(() => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});

type Row = {
  passkeyId: string;
  credentialId: string;
  publicKey: Uint8Array;
  signCount: number;
  transports: string[];
};

let server: Server;
let db: Db;
let closeDb: () => Promise<void>;
let sessions: Sessions;
let cookie: string;
let rows: Row[];
let t: number;
let vaultOn: boolean;
let keyLoads: number;
// When set, reading the key file fails, as a missing or unreadable file would.
let keyBroken: boolean;
let auth: FakeAuthenticator;

// As packages/db behaves: one row per credential id, and a sign count that only moves forward.
function memoryStore(): PasskeyStore {
  return {
    list: async () => rows.map((r) => ({ credentialId: r.credentialId, transports: r.transports })),
    read: async (credentialId) => rows.find((r) => r.credentialId === credentialId) ?? null,
    save: async (input) => {
      const passkeyId = `passkey-${rows.length + 1}`;
      rows.push({ passkeyId, ...input });
      return { ok: true, value: { passkeyId } };
    },
    recordUse: async (passkeyId, signCount) => {
      const row = rows.find((r) => r.passkeyId === passkeyId);
      if (!row) return { ok: false, error: { kind: "NotFound" } };
      if (signCount <= row.signCount)
        return { ok: false, error: { kind: "SignCountNotIncreased" } };
      row.signCount = signCount;
      return { ok: true, value: undefined };
    },
  };
}

beforeEach(async () => {
  exporter.reset();
  rows = [];
  t = 1_000_000;
  vaultOn = true;
  keyLoads = 0;
  keyBroken = false;
  ({ db, close: closeDb } = await createTestDb());
  const seeded = await seedApplication(db, "awaiting_approval");
  const candidateId = CandidateId.parse(seeded.candidateId);
  await setGateClock(db, new Date("2026-11-26T09:00:00Z"));
  const keyText = randomBytes(32).toString("base64");
  const loadKey = (): Promise<MasterKey> => {
    keyLoads += 1;
    if (keyBroken) return Promise.reject(new Error("VAULT_MASTER_KEY_FILE could not be read"));
    return loadVaultKey({ VAULT_MASTER_KEY_FILE: "vault.key" }, async () => keyText);
  };
  await storeTenantPassword(dbVaultPorts(db), await loadKey(), {
    candidateId,
    tenantKey: TENANT,
    actor: "agent:apply",
    password: new VaultSecret(PASSWORD),
  });
  keyLoads = 0;

  sessions = createSessions(() => t);
  cookie = `ns_session=${sessions.open().token}`;
  server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const config: ApiConfig = { signinKeySha256: HASH, port: portOf(server), webOrigin: WEB };
  const store = memoryStore();
  server.on(
    "request",
    createApi({
      config,
      sessions,
      extra: [
        ...passkeyEndpoints({ config, sessions, store, now: () => t }),
        ...vaultRevealEndpoints({
          db,
          candidateId: async () => candidateId,
          sessions,
          assertion: passkeyAssertion({ config, store, now: () => t }),
          isVaultOn: async () => vaultOn,
          loadKey,
          now: () => t,
        }),
      ],
    }),
  );
  // Paul registers one passkey, as on Today.
  auth = fakeAuthenticator({ rpId: RP_ID, origin: WEB });
  const options = await post("/auth/passkey/register/options", { key: "test-key" });
  const verified = await post("/auth/passkey/register/verify", {
    response: auth.register(challengeOf(options)),
  });
  expect(verified.status).toBe(200);
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  await closeDb();
});

const post = (path: string, body: unknown, withCookie = true): Promise<Sent> =>
  send(server, {
    method: "POST",
    path,
    headers: {
      "content-type": "application/json",
      origin: WEB,
      ...(withCookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });

const challengeOf = (res: Sent): string => JSON.parse(res.body).options.challenge;

// A fresh reveal: a reveal challenge, signed by Paul's passkey, sent with the tenant.
async function reveal(tenantKey = TENANT, wait = 0) {
  const options = await post("/vault/reveal/options", {});
  const response = auth.signIn(challengeOf(options));
  t += wait;
  const res = await post("/vault/reveal", { tenantKey, response });
  return { res, response };
}

const accessRows = async () => (await db.select().from(vaultAccess)).length;

describe("revealing a vault password", () => {
  it("gives Paul the password after a fresh passkey check, recording one access", async () => {
    const { res } = await reveal();
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ password: PASSWORD });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(await accessRows()).toBe(1);
  });

  it("answers 401 to both steps without a session, and opens nothing", async () => {
    const options = await post("/vault/reveal/options", {}, false);
    const res = await post(
      "/vault/reveal",
      { tenantKey: TENANT, response: auth.signIn("AAAA") },
      false,
    );
    expect([options.status, res.status]).toEqual([401, 401]);
    expect(await accessRows()).toBe(0);
  });

  it("refuses an assertion answered after its minute, and opens nothing", async () => {
    const { res } = await reveal(TENANT, REVEAL_CHALLENGE_TTL_MS + 1);
    expect(res.status).toBe(401);
    expect(await accessRows()).toBe(0);
  });

  it("refuses the same assertion sent twice", async () => {
    const { response } = await reveal();
    const again = await post("/vault/reveal", { tenantKey: TENANT, response });
    expect(again.status).toBe(401);
    expect(await accessRows()).toBe(1);
  });

  it("refuses a sign-in challenge in place of a reveal challenge", async () => {
    const options = await post("/auth/passkey/sign-in/options", {}, false);
    const res = await post("/vault/reveal", {
      tenantKey: TENANT,
      response: auth.signIn(challengeOf(options)),
    });
    expect(res.status).toBe(401);
    expect(await accessRows()).toBe(0);
  });

  it("refuses an assertion without user verification", async () => {
    const options = await post("/vault/reveal/options", {});
    const res = await post("/vault/reveal", {
      tenantKey: TENANT,
      response: auth.signIn(challengeOf(options), { userVerified: false }),
    });
    expect(res.status).toBe(401);
    expect(await accessRows()).toBe(0);
  });

  it("answers 503 while the vault is switched off, without reading the key", async () => {
    vaultOn = false;
    const { res } = await reveal();
    expect([res.status, JSON.parse(res.body).error]).toEqual([503, "vault_locked"]);
    expect(keyLoads).toBe(0);
    expect(await accessRows()).toBe(0);
  });

  it("answers 404 for a tenant with no password", async () => {
    const { res } = await reveal("workday:globex");
    expect(res.status).toBe(404);
  });

  it(`stops after ${REVEALS_PER_MINUTE} reveals in a minute`, async () => {
    const statuses: number[] = [];
    for (let i = 0; i <= REVEALS_PER_MINUTE; i++) statuses.push((await reveal()).res.status);
    expect(statuses).toEqual([...Array(REVEALS_PER_MINUTE).fill(200), 429]);
  });

  it("never puts the password in a span", async () => {
    await reveal();
    const attributes = JSON.stringify(exporter.getFinishedSpans().map((s) => s.attributes));
    expect(attributes).toContain("revealed");
    expect(attributes).not.toContain(PASSWORD);
  });

  it("refuses an assertion from a passkey that was never registered", async () => {
    const stranger = fakeAuthenticator({ rpId: RP_ID, origin: WEB });
    const options = await post("/vault/reveal/options", {});
    const res = await post("/vault/reveal", {
      tenantKey: TENANT,
      response: stranger.signIn(challengeOf(options)),
    });
    expect(res.status).toBe(401);
    expect(await accessRows()).toBe(0);
  });

  it("counts refused assertions toward the sign-in throttle, then refuses even a good one", async () => {
    // A good assertion, made before the failures.
    const options = await post("/vault/reveal/options", {});
    const good = auth.signIn(challengeOf(options));
    for (let i = 0; i < THROTTLE_LIMIT; i++) {
      const res = await post("/vault/reveal", { tenantKey: TENANT, response: auth.signIn("AAAA") });
      expect(res.status).toBe(401);
    }
    const res = await post("/vault/reveal", { tenantKey: TENANT, response: good });
    const moreOptions = await post("/vault/reveal/options", {});
    expect([res.status, moreOptions.status]).toEqual([429, 429]);
    expect(await accessRows()).toBe(0);
  });

  it("answers 400 for a tenant key the vault doesn't accept", async () => {
    const { res } = await reveal("no-colon-here");
    expect([res.status, JSON.parse(res.body).error]).toEqual([400, "invalid_tenant"]);
  });

  it("answers 503 with no detail when the key can't be read", async () => {
    keyBroken = true;
    const { res } = await reveal();
    expect([res.status, res.body]).toEqual([503, JSON.stringify({ error: "vault_locked" })]);
    expect(await accessRows()).toBe(0);
  });
});
