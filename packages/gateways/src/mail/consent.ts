import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { GMAIL_COMPOSE_SCOPE, GmailComposeAccess } from "./access.js";

// The draft writer's own consent flow (NS-237 slice 5, ADR-0025 items 1, 2 and 6). It is Google's
// desktop authorization-code flow with PKCE (S256), redirected to a one-shot listener on
// 127.0.0.1, under ADR-0014's model: the token lives in memory for one run, with no refresh token.
// It asks for gmail.compose only and keeps the read-only mail reader's flow separate, so the code
// that reads untrusted mail never holds this token. Written for this module after the read-only
// flow in packages/inbox/src/oauth.ts (this package doesn't depend on that one).

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export type ComposeConsentDeps = {
  // The Desktop OAuth client Paul added gmail.compose to (ADR-0025 item 6). Never a token.
  config: { clientId: string; clientSecret: string };
  // Opens the consent page in Paul's browser (the caller prints the URL too).
  openBrowser: (url: string) => Promise<void>;
  // How long to wait for Paul to come back from the consent page.
  timeoutMs: number;
};

// Exchanges the form at Google's token endpoint and returns the parsed answer. Private to this
// module (security review of slice 5): the answer holds the raw access token, and ADR-0025 item 4
// lets only the draft writer hold it. A caller-supplied exchange could keep a copy and call Gmail's
// send around the writer.
type TokenExchange = (body: URLSearchParams) => Promise<Record<string, unknown>>;

export class ComposeConsentError extends Error {
  override name = "ComposeConsentError";
}

// Runs the consent flow once and returns the writer's in-memory token. Throws ComposeConsentError,
// never quoting a token, code or state, on a cancelled consent, a timeout or a grant wider than
// gmail.compose. A grant without gmail.compose (not yet on the OAuth client) still returns a token
// whose hasComposeScope() is false, so the writer says `scope_missing`.
export function authorizeCompose(deps: ComposeConsentDeps): Promise<GmailComposeAccess> {
  return authorizeComposeWith(deps, googleTokenExchange);
}

// The flow with its token exchange as a parameter, for consent.test.ts only. The package entry
// doesn't export it, and the boundary test refuses any import of this module from outside
// src/mail/ but the package entry, so no caller can pass its own exchange.
export async function authorizeComposeWith(
  deps: ComposeConsentDeps,
  exchange: TokenExchange,
): Promise<GmailComposeAccess> {
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
    throw new ComposeConsentError("Google's token response had no access token");
  }
  // The scopes come from Google's answer, never from configuration (slice 4's review): what was
  // granted is what the token can do.
  const granted = typeof json.scope === "string" ? json.scope.split(" ").filter(Boolean) : [];
  // Anything besides compose (an older, broader grant Google remembered, or full mail access)
  // would let the writer's token read or change mail: refuse it rather than hold it.
  if (granted.some((s) => s !== GMAIL_COMPOSE_SCOPE)) {
    throw new ComposeConsentError(
      "Google granted more than gmail.compose; revoke Northstar's access and retry",
    );
  }
  return new GmailComposeAccess(token, granted);
}

// Starts the 127.0.0.1 listener, opens the consent page and waits for one valid callback.
function waitForCode(
  deps: ComposeConsentDeps,
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
          finish(new ComposeConsentError(`Google consent was not given (${word})`)),
        );
        return done(200, "Northstar: consent not given. You can close this tab.");
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.on("finish", () => finish(new ComposeConsentError("The OAuth callback had no code")));
        return done(400, "No code in the callback.");
      }
      // Finish once the page has been sent, so Paul sees it rather than a reset connection.
      res.on("finish", () => finish(null, code));
      done(200, "Northstar can now create Gmail drafts (never send). You can close this tab.");
    });
    const timer = setTimeout(
      () => finish(new ComposeConsentError("No answer from Google's consent page; run it again")),
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
      finish(new ComposeConsentError(`Local sign-in listener failed (${e.name})`)),
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
        scope: GMAIL_COMPOSE_SCOPE,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        // No refresh token: nothing outlives this run (ADR-0014).
        access_type: "online",
      }).toString();
      deps.openBrowser(url.toString()).catch((e: unknown) => {
        // The error's type only: its message could quote anything.
        const name = e instanceof Error ? e.name : "Error";
        finish(new ComposeConsentError(`Couldn't open the consent page (${name})`));
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
  if (!res.ok) throw new ComposeConsentError(`Google's token endpoint answered ${res.status}`);
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new ComposeConsentError("Google's token response wasn't JSON");
  }
};
