import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { CALENDAR_APP_CREATED_SCOPE, CalendarWriteAccess } from "./access.js";

// The Calendar writer's own consent flow (NS-241 slice 3, ADR-0031 items 2 and 8). Google's
// desktop authorization-code flow with PKCE (S256), redirected to a one-shot listener on
// 127.0.0.1, under ADR-0014's model: the token lives in memory for one run, with no refresh token.
// It asks for calendar.app.created only, on its own consent, never folded into the read-only
// reader's calendar.events.readonly token. Written after src/mail/consent.ts, kept apart so each
// writer's token exchange stays inside its own module.

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export type CalendarConsentDeps = {
  // The Desktop OAuth client Paul added calendar.app.created to (ADR-0031 item 8). Never a token.
  config: { clientId: string; clientSecret: string };
  // Opens the consent page in Paul's browser (the caller prints the URL too).
  openBrowser: (url: string) => Promise<void>;
  // How long to wait for Paul to come back from the consent page.
  timeoutMs: number;
};

// Exchanges the form at Google's token endpoint and returns the parsed answer. Private to this
// module (as for the draft writer, NS-237 slice 5): the answer holds the raw access token, and
// ADR-0031 item 2 lets only the Calendar writer hold it. A caller-supplied exchange could keep a
// copy and call Calendar around the writer's allowlist.
type TokenExchange = (body: URLSearchParams) => Promise<Record<string, unknown>>;

export class CalendarConsentError extends Error {
  override name = "CalendarConsentError";
}

// Runs the consent flow once and returns the writer's in-memory token. Throws CalendarConsentError,
// never quoting a token, code or state, on a cancelled consent, a timeout or a grant wider than
// calendar.app.created. A grant without it (not yet on the OAuth client) still returns a token whose
// hasWriteScope() is false, so the writer says `scope_missing`.
export function authorizeCalendarWrite(deps: CalendarConsentDeps): Promise<CalendarWriteAccess> {
  return authorizeCalendarWriteWith(deps, googleTokenExchange);
}

// The flow with its token exchange as a parameter, for consent.test.ts only. The package entry
// doesn't export it, and the boundary test refuses any import of this module from outside
// src/calendar/ but the package entry, so no caller can pass its own exchange.
export async function authorizeCalendarWriteWith(
  deps: CalendarConsentDeps,
  exchange: TokenExchange,
): Promise<CalendarWriteAccess> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  // A random state ties the callback to this run, so another page can't feed us a code.
  const state = randomBytes(16).toString("base64url");

  const { code, redirectUri } = await waitForCode(deps, state, challenge);
  const json = await exchange(
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
    throw new CalendarConsentError("Google's token response had no access token");
  }
  // The scopes come from Google's answer, never from configuration (slice 4's review): what was
  // granted is what the token can do.
  const granted = typeof json.scope === "string" ? json.scope.split(" ").filter(Boolean) : [];
  // Anything besides calendar.app.created (an older, broader grant Google remembered, such as
  // calendar.events or full calendar access) would let the writer's token read or change Paul's
  // own calendars: refuse it rather than hold it.
  if (granted.some((s) => s !== CALENDAR_APP_CREATED_SCOPE)) {
    throw new CalendarConsentError(
      "Google granted more than calendar.app.created; revoke Northstar's access and retry",
    );
  }
  return new CalendarWriteAccess(token, granted);
}

// Starts the 127.0.0.1 listener, opens the consent page and waits for one valid callback.
function waitForCode(
  deps: CalendarConsentDeps,
  state: string,
  challenge: string,
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
      // A request without this run's state is someone else's (another local process, a page
      // probing ports): refuse it but keep waiting, so it can't cancel Paul's sign-in.
      if (url.searchParams.get("state") !== state) {
        return done(400, "This sign-in link doesn't belong to this run.");
      }
      const error = url.searchParams.get("error");
      if (error !== null) {
        // Google's error codes are fixed words such as access_denied; anything else isn't echoed.
        const word = /^[a-z_]{1,40}$/.test(error) ? error : "error";
        res.on("finish", () =>
          finish(new CalendarConsentError(`Google consent was not given (${word})`)),
        );
        return done(200, "Northstar: consent not given. You can close this tab.");
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.on("finish", () => finish(new CalendarConsentError("The OAuth callback had no code")));
        return done(400, "No code in the callback.");
      }
      // Finish once the page has been sent, so Paul sees it rather than a reset connection.
      res.on("finish", () => finish(null, code));
      done(
        200,
        "Northstar can now add approved prep blocks to its own calendar. You can close this tab.",
      );
    });
    const timer = setTimeout(
      () => finish(new CalendarConsentError("No answer from Google's consent page; run it again")),
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
    server.on("error", (e) =>
      finish(new CalendarConsentError(`Local sign-in listener failed (${e.name})`)),
    );
    // Port 0: the OS picks a free port. 127.0.0.1 only, never a public interface.
    server.listen(0, "127.0.0.1", () => {
      redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const url = new URL(AUTH_URL);
      url.search = new URLSearchParams({
        client_id: deps.config.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        // Compose only: never include_granted_scopes, so older grants aren't folded in.
        scope: CALENDAR_APP_CREATED_SCOPE,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        // No refresh token: nothing outlives this run (ADR-0014).
        access_type: "online",
      }).toString();
      deps.openBrowser(url.toString()).catch((e: unknown) => {
        // The error's type only: its message could quote anything.
        const name = e instanceof Error ? e.name : "Error";
        finish(new CalendarConsentError(`Couldn't open the consent page (${name})`));
      });
    });
  });
}

// Google's token endpoint, with a 30 s limit. A non-2xx answer is reported by status only, and an
// answer that isn't JSON by that fact only: a parser's message can quote the body, token and all.
const googleTokenExchange: TokenExchange = async (body) => {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new CalendarConsentError(`Google's token endpoint answered ${res.status}`);
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new CalendarConsentError("Google's token response wasn't JSON");
  }
};
