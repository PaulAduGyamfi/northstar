import { describe, expect, it } from "vitest";
import { TIMED_OUT_MESSAGE } from "./client-fetch";
import {
  addPasskey,
  type CreationJson,
  type Credentials,
  creationOptions,
  type RequestJson,
  requestOptions,
  signInWithPasskey,
} from "./passkey";

// The browser side of passkeys (NS-178 slice 2). A fake credentials container and a fake fetch
// that answers like the API; no browser, device or network. Synthetic bytes only.

const bytes = (...b: number[]) => new Uint8Array(b).buffer;
const view = (buffer: BufferSource | undefined) =>
  buffer ? [...new Uint8Array(buffer as ArrayBuffer)] : undefined;

const CREATION: CreationJson = {
  rp: { name: "Northstar", id: "northstar.localhost" },
  user: { id: "AQID", name: "paul", displayName: "" },
  challenge: "BAUG",
  pubKeyCredParams: [{ alg: -7, type: "public-key" }],
  excludeCredentials: [{ id: "BwgJ", type: "public-key", transports: ["internal"] }],
  authenticatorSelection: { residentKey: "required", userVerification: "required" },
};
const REQUEST: RequestJson = {
  challenge: "CgsM",
  rpId: "northstar.localhost",
  userVerification: "required",
};

// A credential as navigator.credentials would hand back, with fixed bytes.
const credential = (kind: "create" | "get") =>
  ({
    id: "AQI",
    rawId: bytes(1, 2),
    type: "public-key",
    response:
      kind === "create"
        ? {
            clientDataJSON: bytes(3),
            attestationObject: bytes(4, 5),
            getTransports: () => ["internal"],
          }
        : {
            clientDataJSON: bytes(3),
            authenticatorData: bytes(6),
            signature: bytes(7, 8),
            userHandle: bytes(9),
          },
  }) as unknown as PublicKeyCredential;

type Call = { path: string; body: unknown };

// A fake API: options, then verify, with chosen statuses.
function fakeApi(status: { options?: number; verify?: number } = {}) {
  const calls: Call[] = [];
  const fetchFn = (async (path: string, init?: RequestInit) => {
    calls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) });
    if (path.endsWith("/options")) {
      const options = path.includes("register") ? CREATION : REQUEST;
      return new Response(JSON.stringify({ options }), { status: status.options ?? 200 });
    }
    return new Response("{}", { status: status.verify ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const fakeCredentials = (behavior: "answer" | "cancel" = "answer"): Credentials => ({
  create: async () => {
    if (behavior === "cancel") throw new DOMException("cancelled", "NotAllowedError");
    return credential("create");
  },
  get: async () => {
    if (behavior === "cancel") throw new DOMException("cancelled", "NotAllowedError");
    return credential("get");
  },
});

describe("creationOptions and requestOptions", () => {
  it("turns the API's base64url fields into bytes for the browser", () => {
    const c = creationOptions(CREATION);
    const r = requestOptions(REQUEST);
    expect([
      view(c.challenge),
      view(c.user.id),
      c.excludeCredentials?.map((d) => view(d.id)),
      view(r.challenge),
      r.rpId,
    ]).toEqual([[4, 5, 6], [1, 2, 3], [[7, 8, 9]], [10, 11, 12], "northstar.localhost"]);
  });
});

describe("signInWithPasskey", () => {
  it("sends the passkey's answer to the API as base64url and reports success", async () => {
    const api = fakeApi();
    const outcome = await signInWithPasskey(fakeCredentials(), api.fetchFn);
    expect([outcome, api.calls.map((c) => c.path), api.calls[1]?.body]).toEqual([
      { ok: true },
      ["/api/auth/passkey/sign-in/options", "/api/auth/passkey/sign-in/verify"],
      {
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
    ]);
  });

  it("says plainly when the API refuses the passkey", async () => {
    const outcome = await signInWithPasskey(fakeCredentials(), fakeApi({ verify: 401 }).fetchFn);
    expect(outcome).toEqual({
      ok: false,
      message: "That passkey wasn't accepted. Try again, or use your sign-in key.",
    });
  });

  it("says the request was cancelled when Paul closes the browser's dialog", async () => {
    const outcome = await signInWithPasskey(fakeCredentials("cancel"), fakeApi().fetchFn);
    expect(outcome).toEqual({
      ok: false,
      message: "No passkey was used: the request was cancelled or timed out.",
    });
  });
});

describe("addPasskey", () => {
  it("sends the sign-in key with the options request, then the new passkey", async () => {
    const api = fakeApi();
    const outcome = await addPasskey("test-key", fakeCredentials(), api.fetchFn);
    expect([outcome, api.calls[0]?.body, api.calls[1]?.body]).toEqual([
      { ok: true },
      { key: "test-key" },
      {
        response: {
          id: "AQI",
          rawId: "AQI",
          type: "public-key",
          response: { clientDataJSON: "Aw", attestationObject: "BAU", transports: ["internal"] },
          clientExtensionResults: {},
        },
      },
    ]);
  });

  it("stops before the browser's dialog when the key is wrong", async () => {
    let asked = false;
    const credentials: Credentials = {
      create: async () => {
        asked = true;
        return credential("create");
      },
      get: async () => null,
    };
    const outcome = await addPasskey("wrong", credentials, fakeApi({ options: 401 }).fetchFn);
    expect([outcome, asked]).toEqual([
      { ok: false, message: "That key didn't match, or you've been signed out." },
      false,
    ]);
  });

  it("says a passkey added twice is already there", async () => {
    const outcome = await addPasskey(
      "test-key",
      fakeCredentials(),
      fakeApi({ verify: 409 }).fetchFn,
    );
    expect(outcome).toEqual({ ok: false, message: "That passkey is already added." });
  });

  it("says a verify that timed out may have gone through", async () => {
    const fetchFn = (async (path: string) => {
      if (path.endsWith("/verify")) throw new DOMException("timed out", "TimeoutError");
      return new Response(JSON.stringify({ options: CREATION }), { status: 200 });
    }) as unknown as typeof fetch;
    const outcome = await addPasskey("test-key", fakeCredentials(), fetchFn);
    expect(outcome).toEqual({ ok: false, message: TIMED_OUT_MESSAGE });
  });
});
