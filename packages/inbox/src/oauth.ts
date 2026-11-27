import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { CalendarAccess } from "./calendar/access.js";
import type { GoogleConfig } from "./config.js";

// Google's desktop OAuth flow for read-only Gmail (ADR-0014) and, since NS-240 slice 3, read-only
// Calendar events on its own consent (ADR-0026): authorization code + PKCE (S256), redirected to a
// one-shot listener on 127.0.0.1. The token lives in memory for one run only.

export const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
export const CALENDAR_EVENTS_READONLY = "https://www.googleapis.com/auth/calendar.events.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export type OAuthDeps = {
  config: GoogleConfig;
  // Opens the consent page in Paul's browser (bin.ts prints the URL too).
  openBrowser: (url: string) => Promise<void>;
  // POSTs the form to Google's token endpoint and returns its JSON (injected so tests fake it).
  fetchToken: (body: URLSearchParams) => Promise<Record<string, unknown>>;
  // How long to wait for Paul to come back from the consent page.
  timeoutMs: number;
};

// An access token that can be used but never shown: the value is in a private field, and every
// way of turning the object into text (JSON, String, util.inspect / console.log) prints a mask.
export class GmailAccess {
  readonly #token: string;
  constructor(token: string) {
    this.#token = token;
  }
  authorization(): string {
    return `Bearer ${this.#token}`;
  }
  toJSON(): string {
    return "[GmailAccess]";
  }
  toString(): string {
    return "[GmailAccess]";
  }
  [inspect.custom](): string {
    return "[GmailAccess]";
  }
}

export class OAuthError extends Error {
  override name = "OAuthError";
}

// What one consent run asks for: the single scope, the words for the error when Google grants
// anything else, and the line shown in the browser tab once connected.
type ConsentFor = { scope: string; refusal: string; connected: string };

// Runs the consent flow once and returns the in-memory token. Throws OAuthError (never quoting a
// token or code) on a cancelled consent, a forged callback, a timeout or an over-broad grant.
export async function authorizeGmail(deps: OAuthDeps): Promise<GmailAccess> {
  const token = await consentToken(deps, {
    scope: GMAIL_READONLY,
    refusal: "Google granted more than gmail.readonly; revoke the app and retry",
    connected: "Northstar is connected to Gmail (read only). You can close this tab.",
  });
  return new GmailAccess(token);
}

// The Calendar reader's consent (NS-240 slice 3, ADR-0026): `calendar.events.readonly` only, on its
// own consent and token, never with a Gmail scope. Same refusals as authorizeGmail.
export async function authorizeCalendar(deps: OAuthDeps): Promise<CalendarAccess> {
  const token = await consentToken(deps, {
    scope: CALENDAR_EVENTS_READONLY,
    refusal: "Google granted more than calendar.events.readonly; revoke the app and retry",
    connected: "Northstar is connected to Google Calendar (read only). You can close this tab.",
  });
  return new CalendarAccess(token);
}

// The shared flow. Not exported: the raw token leaves it only into a masked access type above.
async function consentToken(deps: OAuthDeps, want: ConsentFor): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  // A random state ties the callback to this run, so another page can't feed us a code.
  const state = randomBytes(16).toString("base64url");

  const { code, redirectUri } = await waitForCode(deps, state, challenge, want);
  const json = await deps.fetchToken(
    new URLSearchParams({
      code,
      client_id: deps.config.clientId,
      client_secret: deps.config.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  );
  const token = json.access_token;
  if (typeof token !== "string" || token === "") {
    throw new OAuthError("Google's token response had no access token");
  }
  // The grant decides, not the request: refuse anything but exactly the one scope asked for, even
  // if Google remembered an older, broader grant.
  const granted = typeof json.scope === "string" ? json.scope.split(" ").filter(Boolean) : [];
  if (granted.length !== 1 || granted[0] !== want.scope) {
    throw new OAuthError(want.refusal);
  }
  return token;
}

// Starts the 127.0.0.1 listener, opens the consent page and waits for one valid callback.
function waitForCode(
  deps: OAuthDeps,
  state: string,
  challenge: string,
  want: ConsentFor,
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let redirectUri = "";
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const done = (status: number, text: string) => {
        res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
        res.end(text);
      };
      if (url.pathname !== "/") return done(404, "Not found");
      if (url.searchParams.get("state") !== state) {
        done(400, "This sign-in link doesn't belong to this run.");
        return finish(new OAuthError("The OAuth callback's state didn't match; nothing was read"));
      }
      const error = url.searchParams.get("error");
      if (error !== null) {
        done(200, "Northstar: consent not given. You can close this tab.");
        // Google's error codes are fixed words such as access_denied.
        const word = /^[a-z_]{1,40}$/.test(error) ? error : "error";
        return finish(new OAuthError(`Google consent was not given (${word})`));
      }
      const code = url.searchParams.get("code");
      if (!code) {
        done(400, "No code in the callback.");
        return finish(new OAuthError("The OAuth callback had no code"));
      }
      done(200, want.connected);
      finish(null, code);
    });
    const timer = setTimeout(
      () => finish(new OAuthError("No answer from Google's consent page; run it again")),
      deps.timeoutMs,
    );
    let settled = false;
    function finish(error: Error | null, code?: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Accept one callback only, then stop listening.
      server.close();
      server.closeAllConnections();
      if (error) reject(error);
      else resolve({ code: code ?? "", redirectUri });
    }
    server.on("error", (e) => finish(new OAuthError(`Local sign-in listener failed (${e.name})`)));
    // Port 0: the OS picks a free port. 127.0.0.1 only, never a public interface.
    server.listen(0, "127.0.0.1", () => {
      redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const url = new URL(AUTH_URL);
      url.search = new URLSearchParams({
        client_id: deps.config.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: want.scope,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        // No refresh token: nothing outlives this run (ADR-0014).
        access_type: "online",
      }).toString();
      deps.openBrowser(url.toString()).catch((e: unknown) => {
        finish(new OAuthError(`Couldn't open the consent page (${(e as Error).name})`));
      });
    });
  });
}

// The real token endpoint, for bin.ts. A non-2xx answer is reported by status only.
export function googleTokenEndpoint(
  fetchFn: typeof fetch,
): (body: URLSearchParams) => Promise<Record<string, unknown>> {
  return async (body) => {
    const res = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new OAuthError(`Google's token endpoint answered ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };
}
