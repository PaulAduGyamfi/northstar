import { randomBytes } from "node:crypto";
import type { PasskeyInput, StoredPasskey } from "@northstar/db";
import type { Result as DomainResult } from "@northstar/domain";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { z } from "zod";
import { sessionCookie } from "./auth.js";
import type { ApiConfig } from "./config.js";
import { type AnyEndpoint, endpoint } from "./endpoint.js";
import type { Sessions } from "./sessions.js";

// Passkey registration and sign-in (NS-178, ADR-0022). The only importer of the WebAuthn library.
// A passkey is bound to Northstar's own name, so a look-alike page can't use it. Registering one
// needs Paul already signed in (by key or passkey); a passkey sign-in opens the same session the
// key does and its failures count toward the same throttle. Credential ids, public keys and
// challenges go nowhere but the store: spans carry outcomes only.

// How long a challenge may be answered, and how many may wait at once (oldest dropped first).
export const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_CHALLENGES = 64;
// COSE algorithms accepted: ES256, EdDSA, RS256 (what platform and security-key passkeys use).
const ALGORITHMS = [-7, -8, -257];
// One user, so one stable WebAuthn user handle: every passkey is "Paul at Northstar".
const USER_ID = new TextEncoder().encode("northstar-paul");

export type PasskeyStore = {
  list: () => Promise<{ credentialId: string; transports: string[] }[]>;
  read: (credentialId: string) => Promise<StoredPasskey | null>;
  save: (
    input: Omit<PasskeyInput, "candidateId">,
  ) => Promise<DomainResult<{ passkeyId: string }, { kind: "AlreadyRegistered" }>>;
  recordUse: (
    passkeyId: string,
    signCount: number,
  ) => Promise<DomainResult<void, { kind: "SignCountNotIncreased" } | { kind: "NotFound" }>>;
};

type Ceremony = "register" | "sign-in";

// Challenges in memory, each answerable once within its time (ADR-0022): a replayed response
// finds its challenge gone. A restart forgets them, which only means asking again.
export function createChallenges(now: () => number) {
  const live = new Map<string, { ceremony: Ceremony; expiresAt: number }>();
  return {
    // Raw bytes for the library (a string it would encode again); kept by their base64url form,
    // which is what the browser echoes back in clientDataJSON.
    issue(ceremony: Ceremony): Uint8Array<ArrayBuffer> {
      const bytes = new Uint8Array(randomBytes(32));
      const challenge = Buffer.from(bytes).toString("base64url");
      if (live.size >= MAX_CHALLENGES) {
        const oldest = live.keys().next().value;
        if (oldest !== undefined) live.delete(oldest);
      }
      live.set(challenge, { ceremony, expiresAt: now() + CHALLENGE_TTL_MS });
      return bytes;
    },
    consume(ceremony: Ceremony, challenge: string): boolean {
      const entry = live.get(challenge);
      live.delete(challenge);
      return entry !== undefined && entry.ceremony === ceremony && now() < entry.expiresAt;
    },
  };
}

const B64U = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(16_384);
const Transports = z.array(z.string().max(32)).max(8);

// The browser's PublicKeyCredential as JSON (WebAuthn Level 3 toJSON()), registration form.
const RegistrationJson = z.object({
  id: B64U,
  rawId: B64U,
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: B64U,
    attestationObject: B64U,
    transports: Transports.optional(),
  }),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()),
});

// The sign-in form.
const AuthenticationJson = z.object({
  id: B64U,
  rawId: B64U,
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: B64U,
    authenticatorData: B64U,
    signature: B64U,
    userHandle: B64U.optional(),
  }),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()),
});

const Options = z.object({ options: z.record(z.string(), z.unknown()) });
// The library's options as the plain JSON object the browser gets.
const asJson = (options: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(options));
const Me = z.object({ user: z.literal("paul") });

export function passkeyEndpoints(deps: {
  config: ApiConfig;
  sessions: Sessions;
  store: PasskeyStore;
  now: () => number;
}): AnyEndpoint[] {
  const { config, sessions, store } = deps;
  const challenges = createChallenges(deps.now);
  // The passkey's scope is the web app's own host name (ADR-0018 item 4), and the browser must
  // report that exact origin.
  const rpID = new URL(config.webOrigin).hostname;
  const expectedOrigin = config.webOrigin;

  const registerOptions = endpoint({
    method: "POST",
    path: "/auth/passkey/register/options",
    auth: "session",
    input: z.object({}),
    output: Options,
    handler: async () => {
      const options = await generateRegistrationOptions({
        rpName: "Northstar",
        rpID,
        userName: "paul",
        userID: USER_ID,
        challenge: challenges.issue("register"),
        attestationType: "none",
        excludeCredentials: (await store.list()).map((p) => ({
          id: p.credentialId,
          transports: p.transports,
        })),
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        supportedAlgorithmIDs: ALGORITHMS,
      });
      return { ok: true, body: { options: asJson(options) } };
    },
  });

  const registerVerify = endpoint({
    method: "POST",
    path: "/auth/passkey/register/verify",
    auth: "session",
    input: z.object({ response: RegistrationJson }),
    output: z.object({}),
    handler: async ({ response }, { span }) => {
      let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
      try {
        verified = await verifyRegistrationResponse({
          response,
          expectedChallenge: (c) => challenges.consume("register", c),
          expectedOrigin,
          expectedRPID: rpID,
          requireUserVerification: true,
          supportedAlgorithmIDs: ALGORITHMS,
        });
      } catch {
        // The library's message can quote the response; the outcome is enough.
        verified = { verified: false };
      }
      if (!verified.verified) {
        span.setAttribute("northstar.passkey.outcome", "registration_refused");
        return { ok: false, status: 400, error: "invalid_passkey" };
      }
      const { credential } = verified.registrationInfo;
      const saved = await store.save({
        credentialId: credential.id,
        publicKey: new Uint8Array(credential.publicKey),
        signCount: credential.counter,
        transports: (credential.transports ?? []).slice(0, 8),
      });
      if (!saved.ok) {
        span.setAttribute("northstar.passkey.outcome", "already_registered");
        return { ok: false, status: 409, error: "already_registered" };
      }
      span.setAttribute("northstar.passkey.outcome", "registered");
      return { ok: true, body: {} };
    },
  });

  const signInOptions = endpoint({
    method: "POST",
    path: "/auth/passkey/sign-in/options",
    auth: "none",
    input: z.object({}),
    output: Options,
    handler: async () => {
      if (sessions.throttled()) return { ok: false, status: 429, error: "throttled" };
      // No allow list: the passkey is discoverable, so the browser offers Paul's own.
      const options = await generateAuthenticationOptions({
        rpID,
        challenge: challenges.issue("sign-in"),
        userVerification: "required",
      });
      return { ok: true, body: { options: asJson(options) } };
    },
  });

  const signInVerify = endpoint({
    method: "POST",
    path: "/auth/passkey/sign-in/verify",
    auth: "none",
    input: z.object({ response: AuthenticationJson }),
    output: Me,
    handler: async ({ response }, { span }) => {
      // Checked first, as for the key: a burst of failures can't be followed by a success.
      if (sessions.throttled()) {
        span.setAttribute("northstar.auth.outcome", "throttled");
        return { ok: false, status: 429, error: "throttled" };
      }
      const refuse = (why: string) => {
        sessions.recordFailure();
        span.setAttribute("northstar.auth.outcome", why);
        return { ok: false as const, status: 401 as const, error: "passkey_refused" };
      };
      const stored = await store.read(response.id);
      if (!stored) return refuse("unknown_passkey");
      let newCounter: number;
      try {
        const verified = await verifyAuthenticationResponse({
          response,
          expectedChallenge: (c) => challenges.consume("sign-in", c),
          expectedOrigin,
          expectedRPID: rpID,
          credential: {
            id: stored.credentialId,
            publicKey: new Uint8Array(stored.publicKey),
            counter: stored.signCount,
            transports: stored.transports,
          },
          requireUserVerification: true,
        });
        if (!verified.verified) return refuse("passkey_refused");
        newCounter = verified.authenticationInfo.newCounter;
      } catch {
        // A replay, a wrong origin, a bad signature or a count that went backwards.
        return refuse("passkey_refused");
      }
      // Stored before the session opens, so two racing sign-ins with one count can't both win.
      const used = await store.recordUse(stored.passkeyId, newCounter);
      if (!used.ok) return refuse("sign_count");
      const { token } = sessions.open();
      span.setAttribute("northstar.auth.outcome", "ok");
      span.setAttribute("northstar.auth.method", "passkey");
      return { ok: true, body: { user: "paul" }, cookies: [sessionCookie(token)] };
    },
  });

  return [registerOptions, registerVerify, signInOptions, signInVerify];
}
