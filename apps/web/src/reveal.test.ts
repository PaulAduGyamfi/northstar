import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Credentials, RequestJson } from "./passkey";
import { MASK_AFTER_MS, revealPassword, startMaskTimer, TIMED_OUT_REVEAL } from "./reveal";

// Revealing a vault password on Settings → Accounts (NS-246 slice 1). A fake credentials container
// and a fake fetch that answers like the API; no browser, device or network. Synthetic values only.

const TENANT = "workday:acme";
const PASSWORD = "test-password-1";
const REQUEST: RequestJson = {
  challenge: "CgsM",
  rpId: "northstar.localhost",
  userVerification: "required",
};

const bytes = (...b: number[]) => new Uint8Array(b).buffer;
const credential = {
  id: "AQI",
  rawId: bytes(1, 2),
  type: "public-key",
  response: {
    clientDataJSON: bytes(3),
    authenticatorData: bytes(6),
    signature: bytes(7, 8),
    userHandle: bytes(9),
  },
} as unknown as PublicKeyCredential;

type Call = { path: string; body: unknown };

function fakeApi(status: { options?: number; reveal?: number; body?: unknown } = {}) {
  const calls: Call[] = [];
  const fetchFn = (async (path: string, init?: RequestInit) => {
    calls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) });
    if (path.endsWith("/options")) {
      return new Response(JSON.stringify({ options: REQUEST }), { status: status.options ?? 200 });
    }
    return new Response(JSON.stringify(status.body ?? { password: PASSWORD }), {
      status: status.reveal ?? 200,
    });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

function fakeCredentials(behavior: "answer" | "cancel" | "wrong-site" = "answer") {
  const gets: CredentialRequestOptions[] = [];
  const credentials: Credentials = {
    create: async () => null,
    get: async (options) => {
      gets.push(options ?? {});
      if (behavior === "cancel") throw new DOMException("cancelled", "NotAllowedError");
      if (behavior === "wrong-site") throw new DOMException("wrong", "SecurityError");
      return credential;
    },
  };
  return { credentials, gets };
}

describe("revealPassword", () => {
  it("asks for this tenant's challenge, runs one passkey prompt and posts one reveal", async () => {
    const api = fakeApi();
    const passkey = fakeCredentials();
    const outcome = await revealPassword(TENANT, passkey.credentials, api.fetchFn);
    expect([outcome, api.calls, passkey.gets.length]).toEqual([
      { ok: true, password: PASSWORD },
      [
        { path: "/api/vault/reveal/options", body: { tenantKey: TENANT } },
        {
          path: "/api/vault/reveal",
          body: {
            tenantKey: TENANT,
            response: {
              id: "AQI",
              rawId: "AQI",
              type: "public-key",
              response: {
                clientDataJSON: "Aw",
                authenticatorData: "Bg",
                signature: "Bwg",
                userHandle: "CQ",
              },
              clientExtensionResults: {},
            },
          },
        },
      ],
      1,
    ]);
  });

  it.each([
    [401, "That passkey wasn't accepted, or you've been signed out. Try again."],
    [
      403,
      "Open Northstar at http://northstar.localhost:3100 (or your NORTHSTAR_WEB_ORIGIN) and try again.",
    ],
    [404, "No password is saved for this account."],
    [429, "Too many tries. Wait a minute, then try again."],
    [503, "The vault is locked. Turn it on in Health, then try again."],
  ])(
    "says plainly what a %i from the reveal means, and shows no password",
    async (status, message) => {
      const outcome = await revealPassword(
        TENANT,
        fakeCredentials().credentials,
        fakeApi({ reveal: status }).fetchFn,
      );
      expect(outcome).toEqual({ ok: false, message });
    },
  );

  it.each([
    [
      403,
      "Open Northstar at http://northstar.localhost:3100 (or your NORTHSTAR_WEB_ORIGIN) and try again.",
    ],
    [429, "Too many tries. Wait a minute, then try again."],
    [500, "Couldn't start the reveal."],
  ])(
    "says plainly what a %i from the options step means, and never prompts",
    async (status, message) => {
      const passkey = fakeCredentials();
      const outcome = await revealPassword(
        TENANT,
        passkey.credentials,
        fakeApi({ options: status }).fetchFn,
      );
      expect([outcome, passkey.gets.length]).toEqual([{ ok: false, message }, 0]);
    },
  );

  it("falls back to a plain message for a reveal status it doesn't know", async () => {
    const outcome = await revealPassword(
      TENANT,
      fakeCredentials().credentials,
      fakeApi({ reveal: 400 }).fetchFn,
    );
    expect(outcome).toEqual({ ok: false, message: "Couldn't reveal it." });
  });

  it("refuses an options answer without a usable challenge, and never prompts", async () => {
    const passkey = fakeCredentials();
    const badOptions = (async () =>
      new Response(JSON.stringify({ options: { challenge: "not base64url!" } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const outcome = await revealPassword(TENANT, passkey.credentials, badOptions);
    expect([outcome, passkey.gets.length]).toEqual([
      { ok: false, message: "Couldn't start the reveal." },
      0,
    ]);
  });

  it("says no passkey was used when the browser hands back nothing, and posts no reveal", async () => {
    const api = fakeApi();
    const empty: Credentials = { create: async () => null, get: async () => null };
    const outcome = await revealPassword(TENANT, empty, api.fetchFn);
    expect([outcome, api.calls.length]).toEqual([
      { ok: false, message: "No passkey was used." },
      1,
    ]);
  });

  it("says a timed-out reveal may still have been revealed and logged", async () => {
    const timingOut = (async () => {
      throw new DOMException("timed out", "TimeoutError");
    }) as unknown as typeof fetch;
    const outcome = await revealPassword(TENANT, fakeCredentials().credentials, timingOut);
    expect(outcome).toEqual({ ok: false, message: TIMED_OUT_REVEAL });
    expect(TIMED_OUT_REVEAL).toBe(
      "No answer in time. It may have been revealed and logged anyway; try again.",
    );
  });

  it("says Paul was signed out when the options step answers 401, and never prompts", async () => {
    const passkey = fakeCredentials();
    const outcome = await revealPassword(
      TENANT,
      passkey.credentials,
      fakeApi({ options: 401 }).fetchFn,
    );
    expect([outcome, passkey.gets.length]).toEqual([
      { ok: false, message: "You've been signed out. Sign in again, then reveal." },
      0,
    ]);
  });

  it("says the prompt was cancelled when the browser refuses it, and posts no reveal", async () => {
    const api = fakeApi();
    const outcome = await revealPassword(
      TENANT,
      fakeCredentials("cancel").credentials,
      api.fetchFn,
    );
    expect([outcome, api.calls.length]).toEqual([
      { ok: false, message: "No passkey was used: the request was cancelled or timed out." },
      1,
    ]);
  });

  it("points to the right address when the browser refuses the site", async () => {
    const outcome = await revealPassword(
      TENANT,
      fakeCredentials("wrong-site").credentials,
      fakeApi().fetchFn,
    );
    expect(outcome).toEqual({
      ok: false,
      message:
        "Open Northstar at http://northstar.localhost:3100 (or your NORTHSTAR_WEB_ORIGIN) and try again.",
    });
  });

  it("refuses an answer that isn't a password, and shows nothing", async () => {
    const outcome = await revealPassword(
      TENANT,
      fakeCredentials().credentials,
      fakeApi({ body: { secret: PASSWORD } }).fetchFn,
    );
    expect(outcome).toEqual({ ok: false, message: "The answer couldn't be read. Try again." });
  });

  it("says it couldn't reach Northstar when the request fails to connect", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const outcome = await revealPassword(TENANT, fakeCredentials().credentials, failing);
    expect(outcome).toEqual({
      ok: false,
      message: "Couldn't reach Northstar. Is the API running?",
    });
  });
});

describe("keeping the password out of storage", () => {
  const stored: string[] = [];
  const spyStorage = () => ({
    setItem: (key: string) => stored.push(key),
    getItem: () => null,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  });

  beforeEach(() => {
    stored.length = 0;
    vi.stubGlobal("localStorage", spyStorage());
    vi.stubGlobal("sessionStorage", spyStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A tripwire on revealPassword itself; the button keeps the password in React state only.
  it("revealPassword itself writes nothing to localStorage or sessionStorage", async () => {
    await revealPassword(TENANT, fakeCredentials().credentials, fakeApi().fetchFn);
    expect(stored).toEqual([]);
  });
});

describe("startMaskTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears the password after 30 seconds and not before", () => {
    const clear = vi.fn();
    startMaskTimer(clear);
    vi.advanceTimersByTime(MASK_AFTER_MS - 1);
    const before = clear.mock.calls.length;
    vi.advanceTimersByTime(1);
    expect([MASK_AFTER_MS, before, clear.mock.calls.length]).toEqual([30_000, 0, 1]);
  });

  it("clears it at once, and only once, when stopped early (Hide, or leaving the page)", () => {
    const clear = vi.fn();
    const stop = startMaskTimer(clear);
    stop();
    vi.advanceTimersByTime(MASK_AFTER_MS);
    expect(clear.mock.calls.length).toBe(1);
  });
});
