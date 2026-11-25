import { z } from "zod";

// Who is looking at a page (NS-156). The web app holds no secret and decides nothing about
// sessions itself: it forwards Paul's session cookie to the API's GET /me and acts on the answer.

export const SESSION_COOKIE = "ns_session";

export type SessionState =
  | { kind: "signed_in"; user: "paul" }
  | { kind: "signed_out" }
  // The API is down or answered something unexpected: show nothing that needs a session.
  | { kind: "unreachable" };

const Me = z.object({ user: z.literal("paul") });
// The API's token shape (32 random bytes, base64url). Anything else is never forwarded.
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
// A page waits at most this long for the API before showing "unreachable".
const TIMEOUT_MS = 3_000;

export async function readSession(deps: {
  apiOrigin: string;
  token: string | undefined;
  fetch: typeof fetch;
}): Promise<SessionState> {
  if (deps.token === undefined || !TOKEN.test(deps.token)) return { kind: "signed_out" };
  try {
    const res = await deps.fetch(`${deps.apiOrigin}/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${deps.token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) return { kind: "signed_out" };
    if (res.status !== 200) return { kind: "unreachable" };
    const me = Me.safeParse(await res.json());
    return me.success ? { kind: "signed_in", user: me.data.user } : { kind: "unreachable" };
  } catch {
    return { kind: "unreachable" };
  }
}

export type TodayView = { redirect: "/sign-in" } | { render: "today" | "unreachable" };

// What the Today page does for each state. A page that needs Paul renders only when signed in.
export function todayView(state: SessionState): TodayView {
  if (state.kind === "signed_out") return { redirect: "/sign-in" };
  if (state.kind === "unreachable") return { render: "unreachable" };
  return { render: "today" };
}
