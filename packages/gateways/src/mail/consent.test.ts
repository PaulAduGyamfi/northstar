import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GMAIL_COMPOSE_SCOPE } from "./access.js";
import {
  authorizeCompose,
  authorizeComposeWith,
  type ComposeConsentDeps,
  ComposeConsentError,
} from "./consent.js";

// A fake OAuth client and token: never a real Google credential (the repo is public). The fake
// browser calls the loopback redirect on 127.0.0.1, which the flow itself is listening on.
const config = { clientId: "test-client.apps.example.com", clientSecret: "test-secret" };
const TOKEN = "ya29.test-compose-token";
const CODE = "test-code-4/0Ab";
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";

type Seen = { authUrl?: URL; tokenBody?: URLSearchParams; callbacks: number[] };

// The test seam: the flow with a fake token exchange. The package entry never exports it, and the
// boundary test refuses any import of consent.ts from outside src/mail/ but the package entry.
type Run = ComposeConsentDeps & {
  exchange: (body: URLSearchParams) => Promise<Record<string, unknown>>;
};
const start = (run: Run) => authorizeComposeWith(run, run.exchange);

function deps(
  seen: Seen,
  opts: {
    consent?: (url: URL) => string;
    tokenResponse?: Record<string, unknown>;
    timeoutMs?: number;
    openBrowser?: () => Promise<void>;
  } = {},
): Run {
  return {
    config,
    timeoutMs: opts.timeoutMs ?? 5_000,
    openBrowser:
      opts.openBrowser ??
      (async (url) => {
        seen.authUrl = new URL(url);
        const redirect = seen.authUrl.searchParams.get("redirect_uri") ?? "";
        const state = seen.authUrl.searchParams.get("state") ?? "";
        const query = opts.consent ? opts.consent(seen.authUrl) : `code=${CODE}&state=${state}`;
        // An empty query: Paul never comes back from the consent page.
        if (query === "") return;
        const res = await fetch(`${redirect}?${query}`);
        seen.callbacks.push(res.status);
      }),
    exchange: async (body) => {
      seen.tokenBody = body;
      return (
        opts.tokenResponse ?? {
          access_token: TOKEN,
          expires_in: 3599,
          scope: GMAIL_COMPOSE_SCOPE,
          token_type: "Bearer",
        }
      );
    },
  };
}

const fresh = (): Seen => ({ callbacks: [] });

// The error a run ends with, for checking that its message never quotes a secret.
async function failure(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the consent flow to refuse");
}

describe("authorizeComposeWith", () => {
  it("asks for gmail.compose only, with PKCE S256, no refresh token and a 127.0.0.1 redirect", async () => {
    const seen = fresh();
    await start(deps(seen));
    const p = seen.authUrl?.searchParams;
    expect(`${seen.authUrl?.origin}${seen.authUrl?.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(p?.get("scope")).toBe("https://www.googleapis.com/auth/gmail.compose");
    expect(p?.get("response_type")).toBe("code");
    expect(p?.get("code_challenge_method")).toBe("S256");
    expect(p?.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p?.get("access_type")).toBe("online");
    expect(p?.get("include_granted_scopes")).toBeNull();
    expect(p?.get("state")).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(p?.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(p?.get("client_id")).toBe(config.clientId);
  });

  it("exchanges the code with the verifier that matches the challenge and the same redirect", async () => {
    const seen = fresh();
    await start(deps(seen));
    const verifier = seen.tokenBody?.get("code_verifier") ?? "";
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      seen.authUrl?.searchParams.get("code_challenge"),
    );
    expect(seen.tokenBody?.get("grant_type")).toBe("authorization_code");
    expect(seen.tokenBody?.get("code")).toBe(CODE);
    expect(seen.tokenBody?.get("redirect_uri")).toBe(
      seen.authUrl?.searchParams.get("redirect_uri"),
    );
    expect(seen.tokenBody?.get("client_id")).toBe(config.clientId);
  });

  it("returns a compose token with the scope Google granted, which prints only a mask", async () => {
    const access = await start(deps(fresh()));
    expect(access.hasComposeScope()).toBe(true);
    expect(access.scopes).toEqual([GMAIL_COMPOSE_SCOPE]);
    expect(JSON.stringify({ access })).not.toContain(TOKEN);
    expect(String(access)).not.toContain(TOKEN);
    expect(inspect(access)).not.toContain(TOKEN);
  });

  it("takes the scopes from Google's answer, so a grant without compose can't write drafts", async () => {
    const access = await start(
      deps(fresh(), { tokenResponse: { access_token: TOKEN, scope: "" } }),
    );
    expect(access.hasComposeScope()).toBe(false);
    expect(access.scopes).toEqual([]);
  });

  it("treats a missing scope field as no scopes granted", async () => {
    const access = await start(deps(fresh(), { tokenResponse: { access_token: TOKEN } }));
    expect(access.hasComposeScope()).toBe(false);
  });

  it("refuses a grant with any scope besides gmail.compose, so the writer's token can't read mail", async () => {
    for (const scope of [
      `${GMAIL_COMPOSE_SCOPE} ${READONLY}`,
      READONLY,
      "https://mail.google.com/",
      `${GMAIL_COMPOSE_SCOPE} https://www.googleapis.com/auth/gmail.modify`,
    ]) {
      const error = await failure(
        start(deps(fresh(), { tokenResponse: { access_token: TOKEN, scope } })),
      );
      expect(error).toBeInstanceOf(ComposeConsentError);
      expect(error.message).toBe(
        "Google granted more than gmail.compose; revoke Northstar's access and retry",
      );
    }
  });

  it("refuses a callback with another state but keeps waiting, so a stray request can't cancel the sign-in", async () => {
    const seen = fresh();
    const error = await failure(
      start(deps(seen, { consent: () => `code=${CODE}&state=forged`, timeoutMs: 300 })),
    );
    expect(seen.callbacks).toEqual([400]);
    expect(error.message).toBe("No answer from Google's consent page; run it again");
    // Google's token endpoint never sees the forged code.
    expect(seen.tokenBody).toBeUndefined();
  });

  it("still signs in when Paul's real callback follows a stray one", async () => {
    const seen = fresh();
    const access = await start({
      ...deps(seen),
      openBrowser: async (url) => {
        const u = new URL(url);
        const redirect = u.searchParams.get("redirect_uri") ?? "";
        seen.callbacks.push((await fetch(`${redirect}?code=stray&state=forged`)).status);
        await fetch(`${redirect}?code=${CODE}&state=${u.searchParams.get("state")}`);
      },
    });
    expect(seen.callbacks).toEqual([400]);
    expect(seen.tokenBody?.get("code")).toBe(CODE);
    expect(access.hasComposeScope()).toBe(true);
  });

  it("reports a refused consent by Google's fixed error word only", async () => {
    const error = await failure(
      start(
        deps(fresh(), {
          consent: (url) => `error=access_denied&state=${url.searchParams.get("state")}`,
        }),
      ),
    );
    expect(error.message).toBe("Google consent was not given (access_denied)");
  });

  it("never echoes an error value that isn't one of Google's plain words", async () => {
    const error = await failure(
      start(
        deps(fresh(), {
          consent: (url) =>
            `error=${encodeURIComponent("<b>Paste your code</b>")}&state=${url.searchParams.get("state")}`,
        }),
      ),
    );
    expect(error.message).toBe("Google consent was not given (error)");
  });

  it("refuses a callback with no code", async () => {
    const error = await failure(
      start(deps(fresh(), { consent: (url) => `state=${url.searchParams.get("state")}` })),
    );
    expect(error.message).toBe("The OAuth callback had no code");
  });

  it("refuses a token answer with no access token, without quoting the answer", async () => {
    const error = await failure(
      start(deps(fresh(), { tokenResponse: { error: "invalid_grant", code: CODE } })),
    );
    expect(error.message).toBe("Google's token response had no access token");
    expect(error.message).not.toContain(CODE);
  });

  it("gives up when Paul never comes back from the consent page", async () => {
    const error = await failure(start(deps(fresh(), { consent: () => "", timeoutMs: 50 })));
    expect(error.message).toBe("No answer from Google's consent page; run it again");
  });

  it("refuses when the consent page can't be opened, naming the error type only", async () => {
    const error = await failure(
      start(
        deps(fresh(), {
          openBrowser: async () => {
            throw new TypeError(`no browser for ${TOKEN}`);
          },
        }),
      ),
    );
    expect(error.message).toBe("Couldn't open the consent page (TypeError)");
  });

  it("accepts one callback only, then stops listening", async () => {
    const seen = fresh();
    let redirect = "";
    await start({
      ...deps(seen),
      openBrowser: async (url) => {
        const u = new URL(url);
        redirect = u.searchParams.get("redirect_uri") ?? "";
        await fetch(`${redirect}?code=${CODE}&state=${u.searchParams.get("state")}`);
      },
    });
    await expect(fetch(`${redirect}?code=again`)).rejects.toThrow();
  });

  it("never puts the code or token in any refusal's message", async () => {
    // Started one at a time: a run left un-awaited while another waits would reject unhandled.
    const runs = [
      () => start(deps(fresh(), { consent: () => `code=${CODE}&state=forged`, timeoutMs: 100 })),
      () => start(deps(fresh(), { tokenResponse: { access_token: TOKEN, scope: READONLY } })),
    ];
    for (const run of runs) {
      const error = await failure(run());
      expect(error.message).not.toContain(CODE);
      expect(error.message).not.toContain(TOKEN);
    }
  });
});

describe("authorizeCompose", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Google's token endpoint answered by a stub; the loopback callback still goes through.
  function stubTokenEndpoint(answer: () => Response): { url?: string; init?: RequestInit } {
    const seen: { url?: string; init?: RequestInit } = {};
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      if (String(url).startsWith("http://127.0.0.1:")) return real(url, init);
      seen.url = String(url);
      seen.init = init;
      return answer();
    });
    return seen;
  }

  // A browser that consents at once.
  const consenting: ComposeConsentDeps = {
    config,
    timeoutMs: 5_000,
    openBrowser: async (url) => {
      const u = new URL(url);
      await fetch(
        `${u.searchParams.get("redirect_uri")}?code=${CODE}&state=${u.searchParams.get("state")}`,
      );
    },
  };

  it("takes no token exchange from its caller, so no caller can keep a copy of the token", () => {
    // ADR-0025 item 4: only the draft writer holds the compose token.
    expect(Object.keys(consenting).sort()).toEqual(["config", "openBrowser", "timeoutMs"]);
    expect(authorizeCompose.length).toBe(1);
  });

  it("exchanges the code at Google's own token endpoint, with a time limit", async () => {
    const seen = stubTokenEndpoint(
      () => new Response(JSON.stringify({ access_token: TOKEN, scope: GMAIL_COMPOSE_SCOPE })),
    );
    const access = await authorizeCompose(consenting);
    expect(access.hasComposeScope()).toBe(true);
    expect(seen.url).toBe("https://oauth2.googleapis.com/token");
    expect(seen.init?.method).toBe("POST");
    expect(seen.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a refused exchange by its status only, never the body", async () => {
    stubTokenEndpoint(
      () => new Response(JSON.stringify({ error_description: CODE }), { status: 400 }),
    );
    const error = await failure(authorizeCompose(consenting));
    expect(error.message).toBe("Google's token endpoint answered 400");
  });

  it("reports an answer that isn't JSON without quoting it", async () => {
    stubTokenEndpoint(() => new Response(`{"access_token":"${TOKEN}"`, { status: 200 }));
    const error = await failure(authorizeCompose(consenting));
    expect(error.message).toBe("Google's token response wasn't JSON");
    expect(error.message).not.toContain(TOKEN);
  });
});
