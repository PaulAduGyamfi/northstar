import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "./config.js";
import { CHALLENGE_TTL_MS, type PasskeyStore, passkeyEndpoints } from "./passkeys.js";
import { createApi } from "./server.js";
import { createSessions, type Sessions, THROTTLE_LIMIT } from "./sessions.js";
import { fakeAuthenticator } from "./test/authenticator.js";
import { portOf, type Sent, send } from "./test/http.js";

// Passkey registration and sign-in (NS-178, ADR-0022) over a real http server, with a fake
// authenticator and the store faked the way packages/db behaves (one row per credential id; the
// sign count only moves forward, or stays at 0). No browser, device or network.

const HASH = "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef"; // sha256("test-key")
const WEB = "http://northstar.localhost:3100";
const RP_ID = "northstar.localhost";

type Row = {
  passkeyId: string;
  credentialId: string;
  publicKey: Uint8Array;
  signCount: number;
  transports: string[];
};

let server: Server;
let sessions: Sessions;
let cookie: string;
let rows: Row[];
let t: number;
let refuseUse: boolean;

function memoryStore(): PasskeyStore {
  return {
    list: async () => rows.map((r) => ({ credentialId: r.credentialId, transports: r.transports })),
    read: async (credentialId) => rows.find((r) => r.credentialId === credentialId) ?? null,
    save: async (input) => {
      if (rows.some((r) => r.credentialId === input.credentialId)) {
        return { ok: false, error: { kind: "AlreadyRegistered" } };
      }
      const passkeyId = `passkey-${rows.length + 1}`;
      rows.push({ passkeyId, ...input });
      return { ok: true, value: { passkeyId } };
    },
    recordUse: async (passkeyId, signCount) => {
      // As packages/db answers when a racing sign-in stored the same count first.
      if (refuseUse) return { ok: false, error: { kind: "SignCountNotIncreased" } };
      const row = rows.find((r) => r.passkeyId === passkeyId);
      if (!row) return { ok: false, error: { kind: "NotFound" } };
      const forward = signCount > row.signCount || (signCount === 0 && row.signCount === 0);
      if (!forward) return { ok: false, error: { kind: "SignCountNotIncreased" } };
      row.signCount = signCount;
      return { ok: true, value: undefined };
    },
  };
}

beforeEach(async () => {
  rows = [];
  t = 0;
  refuseUse = false;
  sessions = createSessions(() => t);
  cookie = `ns_session=${sessions.open().token}`;
  server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const config: ApiConfig = { signinKeySha256: HASH, port: portOf(server), webOrigin: WEB };
  server.on(
    "request",
    createApi({
      config,
      sessions,
      extra: passkeyEndpoints({ config, sessions, store: memoryStore(), now: () => t }),
    }),
  );
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const post = (path: string, body: unknown, withCookie: boolean): Promise<Sent> =>
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

async function register(auth = fakeAuthenticator({ rpId: RP_ID, origin: WEB })) {
  const options = await post("/auth/passkey/register/options", { key: "test-key" }, true);
  const response = auth.register(challengeOf(options));
  const verified = await post("/auth/passkey/register/verify", { response }, true);
  return { auth, options, response, verified };
}

async function signIn(
  auth: ReturnType<typeof fakeAuthenticator>,
  over: Parameters<ReturnType<typeof fakeAuthenticator>["signIn"]>[1] = {},
) {
  const options = await post("/auth/passkey/sign-in/options", {}, false);
  const response = auth.signIn(challengeOf(options), over);
  const verified = await post("/auth/passkey/sign-in/verify", { response }, false);
  return { response, verified };
}

const sessionCookie = (res: Sent): string | undefined =>
  ([res.headers["set-cookie"]].flat().filter(Boolean) as string[]).find((c) =>
    c.startsWith("ns_session="),
  );

describe("registering a passkey", () => {
  it("asks for the sign-in key again, so a session alone can't add a passkey", async () => {
    const withoutKey = await post("/auth/passkey/register/options", {}, true);
    const wrongKey = await post("/auth/passkey/register/options", { key: "not-the-key" }, true);
    expect([withoutKey.status, wrongKey.status]).toEqual([400, 401]);
  });

  it("counts a wrong key at registration toward the sign-in throttle", async () => {
    for (let i = 0; i < THROTTLE_LIMIT; i++) {
      await post("/auth/passkey/register/options", { key: "not-the-key" }, true);
    }
    const right = await post("/auth/passkey/register/options", { key: "test-key" }, true);
    expect(right.status).toBe(429);
  });

  it("refuses a sign-in challenge answered as a registration", async () => {
    const auth = fakeAuthenticator({ rpId: RP_ID, origin: WEB });
    const signInOptions = await post("/auth/passkey/sign-in/options", {}, false);
    const response = auth.register(challengeOf(signInOptions));
    const verified = await post("/auth/passkey/register/verify", { response }, true);
    expect([verified.status, rows.length]).toEqual([400, 0]);
  });

  it("needs Paul signed in: without a session both steps answer 401 and store nothing", async () => {
    const auth = fakeAuthenticator({ rpId: RP_ID, origin: WEB });
    const options = await post("/auth/passkey/register/options", { key: "test-key" }, false);
    const verified = await post(
      "/auth/passkey/register/verify",
      { response: auth.register("AAAAAAAAAAAAAAAAAAAAAA") },
      false,
    );
    expect([options.status, verified.status, rows.length]).toEqual([401, 401, 0]);
  });

  it("stores the passkey a signed-in Paul registers, for Northstar's own name", async () => {
    const { auth, options, verified } = await register();
    expect([
      verified.status,
      JSON.parse(options.body).options.rp.id,
      rows.map((r) => [r.credentialId, r.signCount, r.transports]),
    ]).toEqual([200, RP_ID, [[auth.credentialId, 0, ["internal"]]]]);
  });

  it("asks the authenticator to verify Paul and to keep a discoverable passkey", async () => {
    const options = JSON.parse(
      (await post("/auth/passkey/register/options", { key: "test-key" }, true)).body,
    );
    expect(options.options.authenticatorSelection).toMatchObject({
      residentKey: "required",
      userVerification: "required",
    });
  });

  it("refuses a registration response sent twice, because its challenge is used up", async () => {
    const { response } = await register();
    const again = await post("/auth/passkey/register/verify", { response }, true);
    expect([again.status, rows.length]).toEqual([400, 1]);
  });

  it("refuses a registration without user verification", async () => {
    const auth = fakeAuthenticator({ rpId: RP_ID, origin: WEB });
    const options = await post("/auth/passkey/register/options", { key: "test-key" }, true);
    const response = auth.register(challengeOf(options), { userVerified: false });
    const verified = await post("/auth/passkey/register/verify", { response }, true);
    expect([verified.status, rows.length]).toEqual([400, 0]);
  });

  it("lists the passkeys already registered so the browser won't add the same one twice", async () => {
    const { auth } = await register();
    const options = JSON.parse(
      (await post("/auth/passkey/register/options", { key: "test-key" }, true)).body,
    );
    expect(options.options.excludeCredentials.map((c: { id: string }) => c.id)).toEqual([
      auth.credentialId,
    ]);
  });
});

describe("signing in with a passkey", () => {
  it("refuses a sign-in without user verification", async () => {
    const { auth } = await register();
    const { verified } = await signIn(auth, { userVerified: false });
    expect([verified.status, sessionCookie(verified)]).toEqual([401, undefined]);
  });

  it("opens no session when the store refuses the count, and counts it as a failure", async () => {
    const { auth } = await register();
    refuseUse = true;
    const results: Sent[] = [];
    for (let i = 0; i < THROTTLE_LIMIT; i++) results.push((await signIn(auth)).verified);
    const next = await post("/auth/passkey/sign-in/options", {}, false);
    expect([results.map((r) => [r.status, sessionCookie(r)]), next.status]).toEqual([
      Array.from({ length: THROTTLE_LIMIT }, () => [401, undefined]),
      429,
    ]);
  });

  it("opens a session the rest of the API accepts", async () => {
    const { auth } = await register();
    const { verified } = await signIn(auth);
    const fresh = sessionCookie(verified)?.split(";")[0] ?? "";
    const me = await send(server, { method: "GET", path: "/me", headers: { cookie: fresh } });
    expect([verified.status, JSON.parse(verified.body), me.status]).toEqual([
      200,
      { user: "paul" },
      200,
    ]);
  });

  it("records the authenticator's new sign count", async () => {
    const { auth } = await register();
    await signIn(auth);
    await signIn(auth);
    expect(rows.map((r) => r.signCount)).toEqual([2]);
  });

  it("refuses a sign-in response sent twice and opens no session", async () => {
    const { auth } = await register();
    const { response } = await signIn(auth);
    const again = await post("/auth/passkey/sign-in/verify", { response }, false);
    expect([again.status, sessionCookie(again)]).toEqual([401, undefined]);
  });

  it("refuses a response signed for another origin", async () => {
    const { auth } = await register();
    const { verified } = await signIn(auth, { origin: "http://evil.example.com" });
    expect([verified.status, sessionCookie(verified)]).toEqual([401, undefined]);
  });

  it("refuses a passkey that was never registered", async () => {
    await register();
    const stranger = fakeAuthenticator({ rpId: RP_ID, origin: WEB });
    const { verified } = await signIn(stranger);
    expect([verified.status, sessionCookie(verified)]).toEqual([401, undefined]);
  });

  it("refuses a sign count that didn't move forward, as a cloned key would send", async () => {
    const { auth } = await register();
    await signIn(auth, { counter: 5 });
    const { verified } = await signIn(auth, { counter: 5 });
    expect([verified.status, sessionCookie(verified)]).toEqual([401, undefined]);
  });

  it("accepts a platform passkey whose count stays at 0", async () => {
    const auth = fakeAuthenticator({ rpId: RP_ID, origin: WEB, counting: false });
    await register(auth);
    const first = await signIn(auth);
    const second = await signIn(auth);
    expect([first.verified.status, second.verified.status]).toEqual([200, 200]);
  });

  it("refuses a challenge older than five minutes", async () => {
    const { auth } = await register();
    const options = await post("/auth/passkey/sign-in/options", {}, false);
    t += CHALLENGE_TTL_MS;
    const response = auth.signIn(challengeOf(options));
    const verified = await post("/auth/passkey/sign-in/verify", { response }, false);
    expect(verified.status).toBe(401);
  });

  it("counts failed passkey sign-ins toward the sign-in throttle", async () => {
    await register();
    const stranger = fakeAuthenticator({ rpId: RP_ID, origin: WEB });
    for (let i = 0; i < THROTTLE_LIMIT; i++) await signIn(stranger);
    const key = await post("/auth/sign-in", { key: "test-key" }, false);
    const options = await post("/auth/passkey/sign-in/options", {}, false);
    expect([key.status, options.status]).toEqual([429, 429]);
  });
});
