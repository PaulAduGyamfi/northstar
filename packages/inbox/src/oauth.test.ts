import { describe, expect, it } from "vitest";
import { loadGoogleConfig } from "./config.js";
import { authorizeGmail, GMAIL_READONLY, type OAuthDeps } from "./oauth.js";

// Fake client and token: never a real Google credential (the repo is public).
const config = { clientId: "test-client.apps.example.com", clientSecret: "test-secret" };
const TOKEN = "ya29.test-access-token";

type Seen = { authUrl?: URL; tokenBody?: URLSearchParams };

// A browser that consents (or not) by calling the loopback redirect, and a fake token endpoint.
function deps(
  seen: Seen,
  opts: {
    consent?: (url: URL) => string;
    tokenResponse?: Record<string, unknown>;
    timeoutMs?: number;
  } = {},
): OAuthDeps {
  return {
    config,
    timeoutMs: opts.timeoutMs ?? 5_000,
    openBrowser: async (url) => {
      seen.authUrl = new URL(url);
      const redirect = seen.authUrl.searchParams.get("redirect_uri") ?? "";
      const state = seen.authUrl.searchParams.get("state") ?? "";
      const query = opts.consent ? opts.consent(seen.authUrl) : `code=test-code&state=${state}`;
      if (query === "") return; // the user never comes back
      await fetch(`${redirect}?${query}`);
    },
    fetchToken: async (body) => {
      seen.tokenBody = body;
      return (
        opts.tokenResponse ?? {
          access_token: TOKEN,
          expires_in: 3599,
          scope: GMAIL_READONLY,
          token_type: "Bearer",
        }
      );
    },
  };
}

describe("authorizeGmail", () => {
  it("asks for gmail.readonly only, with PKCE S256, no refresh token and a 127.0.0.1 redirect", async () => {
    const seen: Seen = {};
    await authorizeGmail(deps(seen));
    const p = seen.authUrl?.searchParams;
    expect(seen.authUrl?.origin).toBe("https://accounts.google.com");
    expect(p?.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(p?.get("code_challenge_method")).toBe("S256");
    expect(p?.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p?.get("access_type")).toBe("online");
    expect(p?.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("exchanges the code with the PKCE verifier that matches the challenge", async () => {
    const seen: Seen = {};
    await authorizeGmail(deps(seen));
    const verifier = seen.tokenBody?.get("code_verifier") ?? "";
    const { createHash } = await import("node:crypto");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(seen.authUrl?.searchParams.get("code_challenge"));
    expect(seen.tokenBody?.get("grant_type")).toBe("authorization_code");
    expect(seen.tokenBody?.get("code")).toBe("test-code");
  });

  it("the access token can be used but never printed or serialized", async () => {
    const access = await authorizeGmail(deps({}));
    expect(access.authorization()).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify({ access })).not.toContain(TOKEN);
    expect(String(access)).not.toContain(TOKEN);
    const { inspect } = await import("node:util");
    expect(inspect(access)).not.toContain(TOKEN);
  });

  it("refuses a callback whose state doesn't match", async () => {
    const run = authorizeGmail(deps({}, { consent: () => "code=x&state=forged" }));
    await expect(run).rejects.toThrow("state didn't match");
  });

  it("stops when the user cancels on Google's consent page", async () => {
    const run = authorizeGmail(
      deps({}, { consent: (u) => `error=access_denied&state=${u.searchParams.get("state")}` }),
    );
    await expect(run).rejects.toThrow("Google consent was not given (access_denied)");
  });

  it("stops after the timeout when the user never comes back", async () => {
    const run = authorizeGmail(deps({}, { consent: () => "", timeoutMs: 50 }));
    await expect(run).rejects.toThrow("No answer from Google's consent page");
  });

  it("refuses a token that grants more than gmail.readonly", async () => {
    const run = authorizeGmail(
      deps(
        {},
        {
          tokenResponse: {
            access_token: TOKEN,
            scope: `${GMAIL_READONLY} https://www.googleapis.com/auth/gmail.send`,
          },
        },
      ),
    );
    await expect(run).rejects.toThrow("Google granted more than gmail.readonly");
  });

  it("never puts the token in an error message", async () => {
    const run = authorizeGmail(
      deps(
        {},
        {
          tokenResponse: {
            access_token: TOKEN,
            scope: "https://www.googleapis.com/auth/gmail.send",
          },
        },
      ),
    );
    await expect(run).rejects.not.toThrow(TOKEN);
  });
});

describe("loadGoogleConfig", () => {
  it("names a missing setting without echoing any value", () => {
    expect(() => loadGoogleConfig({ GOOGLE_OAUTH_CLIENT_SECRET: "s3cret" })).toThrow(
      "GOOGLE_OAUTH_CLIENT_ID missing",
    );
    expect(() => loadGoogleConfig({ GOOGLE_OAUTH_CLIENT_SECRET: "s3cret" })).not.toThrow("s3cret");
  });

  it("refuses the .env.example placeholder", () => {
    expect(() =>
      loadGoogleConfig({ GOOGLE_OAUTH_CLIENT_ID: "change-me", GOOGLE_OAUTH_CLIENT_SECRET: "x" }),
    ).toThrow("still the placeholder");
  });
});
