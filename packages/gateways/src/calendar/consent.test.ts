import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { CALENDAR_APP_CREATED_SCOPE } from "./access.js";
import {
  authorizeCalendarWriteWith,
  type CalendarConsentDeps,
  CalendarConsentError,
} from "./consent.js";

// The Calendar writer's consent flow (NS-241 slice 3, ADR-0031 item 2) with a fake OAuth client
// and token, never a real Google credential (the repo is public). The fake browser calls the
// loopback redirect on 127.0.0.1, which the flow itself is listening on.
const config = { clientId: "test-client.apps.example.com", clientSecret: "test-secret" };
const TOKEN = "ya29.test-calendar-write-token";
const CODE = "test-code-4/0Ab";
const EVENTS = "https://www.googleapis.com/auth/calendar.events";
const READONLY = "https://www.googleapis.com/auth/calendar.events.readonly";

type Seen = { authUrl?: URL; tokenBody?: URLSearchParams };
type Run = CalendarConsentDeps & {
  exchange: (body: URLSearchParams) => Promise<Record<string, unknown>>;
};
const start = (run: Run) => authorizeCalendarWriteWith(run, run.exchange);

function deps(seen: Seen, tokenResponse?: Record<string, unknown>, consent?: string): Run {
  return {
    config,
    timeoutMs: 5_000,
    openBrowser: async (url) => {
      seen.authUrl = new URL(url);
      const redirect = seen.authUrl.searchParams.get("redirect_uri") ?? "";
      const state = seen.authUrl.searchParams.get("state") ?? "";
      await fetch(`${redirect}?${consent ?? `code=${CODE}`}&state=${state}`);
    },
    exchange: async (body) => {
      seen.tokenBody = body;
      return tokenResponse ?? { access_token: TOKEN, scope: CALENDAR_APP_CREATED_SCOPE };
    },
  };
}

async function failure(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the consent flow to refuse");
}

describe("authorizeCalendarWriteWith", () => {
  it("asks for calendar.app.created only, with PKCE S256, no refresh token and a 127.0.0.1 redirect", async () => {
    const seen: Seen = {};
    await start(deps(seen));
    const p = seen.authUrl?.searchParams;
    expect([
      p?.get("scope"),
      p?.get("code_challenge_method"),
      p?.get("access_type"),
      p?.get("include_granted_scopes"),
      /^http:\/\/127\.0\.0\.1:\d+$/.test(p?.get("redirect_uri") ?? ""),
    ]).toEqual([CALENDAR_APP_CREATED_SCOPE, "S256", "online", null, true]);
  });

  it("exchanges the code with the verifier that matches the challenge", async () => {
    const seen: Seen = {};
    await start(deps(seen));
    const verifier = seen.tokenBody?.get("code_verifier") ?? "";
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      seen.authUrl?.searchParams.get("code_challenge"),
    );
  });

  it("returns a write token with the scope Google granted, which prints only a mask", async () => {
    const access = await start(deps({}));
    expect([
      access.hasWriteScope(),
      JSON.stringify({ access }).includes(TOKEN),
      String(access).includes(TOKEN),
      inspect(access).includes(TOKEN),
    ]).toEqual([true, false, false, false]);
  });

  it("takes the scopes from Google's answer, so a grant without the scope can't write", async () => {
    const access = await start(deps({}, { access_token: TOKEN, scope: "" }));
    expect([access.hasWriteScope(), access.scopes]).toEqual([false, []]);
  });

  it("refuses any grant wider than calendar.app.created, never quoting the token", async () => {
    for (const scope of [
      `${CALENDAR_APP_CREATED_SCOPE} ${EVENTS}`,
      EVENTS,
      `${CALENDAR_APP_CREATED_SCOPE} ${READONLY}`,
      "https://www.googleapis.com/auth/calendar",
    ]) {
      const error = await failure(start(deps({}, { access_token: TOKEN, scope })));
      expect([error instanceof CalendarConsentError, error.message.includes(TOKEN)]).toEqual([
        true,
        false,
      ]);
    }
  });

  it("refuses an answer with no access token", async () => {
    const error = await failure(start(deps({}, { scope: CALENDAR_APP_CREATED_SCOPE })));
    expect(error.message).toBe("Google's token response had no access token");
  });

  it("reports a refused consent by Google's error word only", async () => {
    const error = await failure(start(deps({}, undefined, "error=access_denied")));
    expect(error.message).toBe("Google consent was not given (access_denied)");
  });
});
