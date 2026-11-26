import { z } from "zod";
import { apiFetch, isTimeout, TIMED_OUT_MESSAGE } from "./client-fetch";

// The browser side of passkeys (NS-178 slice 2, ADR-0022): turn the API's JSON options into what
// navigator.credentials wants, and the authenticator's answer back into JSON. Written by hand
// because the browsers' own JSON helpers (parseCreationOptionsFromJSON, toJSON) aren't in every
// browser yet. The credentials container and fetch are passed in, so tests need no browser.

export type Credentials = Pick<CredentialsContainer, "create" | "get">;
export type Outcome = { ok: true } | { ok: false; message: string };

const fromB64u = (text: string): ArrayBuffer => {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

const toB64u = (buffer: ArrayBuffer): string => {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

type DescriptorJson = { id: string; type: "public-key"; transports?: string[] };
const descriptor = (d: DescriptorJson): PublicKeyCredentialDescriptor => ({
  id: fromB64u(d.id),
  type: d.type,
  transports: d.transports as AuthenticatorTransport[] | undefined,
});

// The API's registration options (generateRegistrationOptions) as the browser's type.
export type CreationJson = Omit<
  PublicKeyCredentialCreationOptions,
  "challenge" | "user" | "excludeCredentials"
> & {
  challenge: string;
  user: { id: string; name: string; displayName: string };
  excludeCredentials?: DescriptorJson[];
};

export function creationOptions(json: CreationJson): PublicKeyCredentialCreationOptions {
  return {
    ...json,
    challenge: fromB64u(json.challenge),
    user: { ...json.user, id: fromB64u(json.user.id) },
    excludeCredentials: (json.excludeCredentials ?? []).map(descriptor),
  };
}

// The API's sign-in options (generateAuthenticationOptions) as the browser's type.
export type RequestJson = Omit<
  PublicKeyCredentialRequestOptions,
  "challenge" | "allowCredentials"
> & {
  challenge: string;
  allowCredentials?: DescriptorJson[];
};

export function requestOptions(json: RequestJson): PublicKeyCredentialRequestOptions {
  return {
    ...json,
    challenge: fromB64u(json.challenge),
    allowCredentials: (json.allowCredentials ?? []).map(descriptor),
  };
}

// What the API's register/verify reads.
export function registrationJson(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: toB64u(credential.rawId),
    type: "public-key" as const,
    response: {
      clientDataJSON: toB64u(response.clientDataJSON),
      attestationObject: toB64u(response.attestationObject),
      transports: response.getTransports?.() ?? [],
    },
    clientExtensionResults: {},
  };
}

// What the API's sign-in/verify reads.
export function authenticationJson(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: toB64u(credential.rawId),
    type: "public-key" as const,
    response: {
      clientDataJSON: toB64u(response.clientDataJSON),
      authenticatorData: toB64u(response.authenticatorData),
      signature: toB64u(response.signature),
      ...(response.userHandle ? { userHandle: toB64u(response.userHandle) } : {}),
    },
    clientExtensionResults: {},
  };
}

// The API's answers in plain words.
const WRONG_ADDRESS =
  "Open Northstar at http://northstar.localhost:3100 (or your NORTHSTAR_WEB_ORIGIN) and try again.";
const TOO_MANY = "Too many tries. Wait a minute, then try again.";
const SIGN_IN_MESSAGES: Record<number, string> = {
  401: "That passkey wasn't accepted. Try again, or use your sign-in key.",
  403: WRONG_ADDRESS,
  429: TOO_MANY,
};
// The options step checks the key; the verify step only the session.
const ADD_OPTIONS_MESSAGES: Record<number, string> = {
  401: "That key didn't match, or you've been signed out.",
  403: WRONG_ADDRESS,
  429: TOO_MANY,
};
const ADD_VERIFY_MESSAGES: Record<number, string> = {
  400: "The browser's passkey wasn't accepted. Try again.",
  401: "You've been signed out. Sign in again, then add the passkey.",
  403: WRONG_ADDRESS,
  409: "That passkey is already added.",
};

// The options body, checked before the browser sees it (the fields it needs as base64url).
const OptionsBody = z.object({
  options: z.looseObject({ challenge: z.string().regex(/^[A-Za-z0-9_-]+$/) }),
});

const post = (path: string, body: unknown, fetchFn: typeof fetch) =>
  apiFetch(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    fetchFn,
  );

// What went wrong, from the browser's own errors. Its dialog refuses with NotAllowedError (Paul
// cancelled, it timed out, or this device has no passkey for Northstar); InvalidStateError means
// the device already has one (the exclude list); SecurityError means the page isn't on the name
// passkeys are made for. A fetch that never connected throws a TypeError.
function errorMessage(error: unknown, ceremony: "sign-in" | "add"): string {
  if (isTimeout(error)) return TIMED_OUT_MESSAGE;
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      return ceremony === "sign-in"
        ? "No passkey was used: the request was cancelled, timed out, or this device has no passkey for Northstar. You can use your sign-in key."
        : "No passkey was made: the request was cancelled or timed out.";
    }
    if (error.name === "InvalidStateError") return "This device already has a Northstar passkey.";
    if (error.name === "SecurityError") return WRONG_ADDRESS;
    return "Something went wrong with the passkey. Try again.";
  }
  return "Couldn't reach Northstar. Is the API running?";
}

export async function signInWithPasskey(
  credentials: Credentials,
  fetchFn: typeof fetch = fetch,
): Promise<Outcome> {
  try {
    const optionsRes = await post("/api/auth/passkey/sign-in/options", {}, fetchFn);
    if (!optionsRes.ok)
      return {
        ok: false,
        message: SIGN_IN_MESSAGES[optionsRes.status] ?? "Couldn't start a passkey sign-in.",
      };
    const body = OptionsBody.safeParse(await optionsRes.json());
    if (!body.success) return { ok: false, message: "Couldn't start a passkey sign-in." };
    // Checked above for the challenge; the rest is the browser's to judge.
    const options = body.data.options as unknown as RequestJson;
    const credential = await credentials.get({ publicKey: requestOptions(options) });
    if (!credential) return { ok: false, message: "No passkey was used." };
    const response = authenticationJson(credential as PublicKeyCredential);
    const verified = await post("/api/auth/passkey/sign-in/verify", { response }, fetchFn);
    if (verified.ok) return { ok: true };
    return { ok: false, message: SIGN_IN_MESSAGES[verified.status] ?? "Couldn't sign in." };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "sign-in") };
  }
}

// Adding a passkey asks for the sign-in key again (ADR-0022 item 2).
export async function addPasskey(
  key: string,
  credentials: Credentials,
  fetchFn: typeof fetch = fetch,
): Promise<Outcome> {
  try {
    const optionsRes = await post("/api/auth/passkey/register/options", { key }, fetchFn);
    if (!optionsRes.ok)
      return {
        ok: false,
        message: ADD_OPTIONS_MESSAGES[optionsRes.status] ?? "Couldn't start adding a passkey.",
      };
    const body = OptionsBody.safeParse(await optionsRes.json());
    if (!body.success) return { ok: false, message: "Couldn't start adding a passkey." };
    // Checked above for the challenge; the rest is the browser's to judge.
    const options = body.data.options as unknown as CreationJson;
    const credential = await credentials.create({ publicKey: creationOptions(options) });
    if (!credential) return { ok: false, message: "No passkey was made." };
    const response = registrationJson(credential as PublicKeyCredential);
    const verified = await post("/api/auth/passkey/register/verify", { response }, fetchFn);
    if (verified.ok) return { ok: true };
    return {
      ok: false,
      message: ADD_VERIFY_MESSAGES[verified.status] ?? "The passkey couldn't be added.",
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "add") };
  }
}
