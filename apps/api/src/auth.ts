import { z } from "zod";
import type { ApiConfig } from "./config.js";
import { type AnyEndpoint, endpoint } from "./endpoint.js";
import { keyMatches, SESSION_TTL_MS, type Sessions } from "./sessions.js";

// Paul's sign-in, sign-out and "who am I" (NS-156, ADR-0018). One user, so the answer is "paul".

export const SESSION_COOKIE = "ns_session";

const Me = z.object({ user: z.literal("paul") });

// HttpOnly: page scripts can't read it. SameSite=Strict: no other site's request carries it.
// No Secure flag: served over http on loopback only (ADR-0018); add it with https.
const sessionCookie = (token: string) =>
  `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
const clearedCookie = `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

export function authEndpoints(config: ApiConfig, sessions: Sessions): AnyEndpoint[] {
  const signIn = endpoint({
    method: "POST",
    path: "/auth/sign-in",
    auth: "none",
    input: z.object({ key: z.string().min(1).max(512) }),
    output: Me,
    handler: async ({ key }, { span }) => {
      // Checked first, so a burst of guesses can't be followed by the right key in the window.
      if (sessions.throttled()) {
        span.setAttribute("northstar.auth.outcome", "throttled");
        return { ok: false, status: 429, error: "throttled" };
      }
      if (!keyMatches(key, config.signinKeySha256)) {
        sessions.recordFailure();
        span.setAttribute("northstar.auth.outcome", "wrong_key");
        return { ok: false, status: 401, error: "wrong_key" };
      }
      const { token } = sessions.open();
      span.setAttribute("northstar.auth.outcome", "ok");
      return { ok: true, body: { user: "paul" }, cookies: [sessionCookie(token)] };
    },
  });

  const signOut = endpoint({
    method: "POST",
    path: "/auth/sign-out",
    auth: "session",
    input: z.object({}),
    output: z.object({}),
    handler: async (_input, { session }) => {
      if (session) sessions.close(session);
      return { ok: true, body: {}, cookies: [clearedCookie] };
    },
  });

  const me = endpoint({
    method: "GET",
    path: "/me",
    auth: "session",
    input: z.object({}),
    output: Me,
    handler: async () => ({ ok: true, body: { user: "paul" } }),
  });

  return [signIn, signOut, me];
}
