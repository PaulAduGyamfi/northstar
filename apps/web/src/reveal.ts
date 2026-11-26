import { z } from "zod";
import { apiFetch, isTimeout } from "./client-fetch";
import { authenticationJson, type Credentials, type RequestJson, requestOptions } from "./passkey";

// Revealing one of Paul's vault passwords on Settings → Accounts (NS-246 slice 1, CRD-002,
// ADR-0024). The API does the checking: a session, a fresh passkey assertion bound to this tenant,
// the `vault` switch and a rate limit (NS-230, NS-245). This side only asks for the challenge,
// runs the browser's passkey prompt and posts the answer. It takes the credentials container and
// fetch as arguments so tests need no browser. The password comes back to the caller and nowhere
// else: never storage, a cookie, the URL or a log.

// How long a revealed password stays on screen.
export const MASK_AFTER_MS = 30_000;

export type RevealOutcome = { ok: true; password: string } | { ok: false; message: string };

const WRONG_ADDRESS =
  "Open Northstar at http://northstar.localhost:3100 (or your NORTHSTAR_WEB_ORIGIN) and try again.";
const TOO_MANY = "Too many tries. Wait a minute, then try again.";
// The options step needs only the session.
const OPTIONS_MESSAGES: Record<number, string> = {
  401: "You've been signed out. Sign in again, then reveal.",
  403: WRONG_ADDRESS,
  429: TOO_MANY,
};
// The reveal step checks the passkey, the vault switch and that a password is saved.
const REVEAL_MESSAGES: Record<number, string> = {
  401: "That passkey wasn't accepted. Try again.",
  403: WRONG_ADDRESS,
  404: "No password is saved for this account.",
  429: TOO_MANY,
  503: "The vault is locked. Turn it on in Health, then try again.",
};
const UNREADABLE = "The answer couldn't be read. Try again.";

// The options body, checked before the browser sees it (the challenge as base64url).
const OptionsBody = z.object({
  options: z.looseObject({ challenge: z.string().regex(/^[A-Za-z0-9_-]+$/) }),
});
const RevealedBody = z.object({ password: z.string().min(1) });

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

// The browser's own errors in plain words. A timed-out reveal may still have been recorded (the
// API logs each vault access and uses its one-time approval), but it changes nothing Paul needs to
// check, so trying again is the whole advice.
function errorMessage(error: unknown): string {
  if (isTimeout(error)) return "No answer in time. Try again.";
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      return "No passkey was used: the request was cancelled or timed out.";
    }
    if (error.name === "SecurityError") return WRONG_ADDRESS;
    return "Something went wrong with the passkey. Try again.";
  }
  return "Couldn't reach Northstar. Is the API running?";
}

export async function revealPassword(
  tenantKey: string,
  credentials: Credentials,
  fetchFn: typeof fetch = fetch,
): Promise<RevealOutcome> {
  try {
    const optionsRes = await post("/api/vault/reveal/options", { tenantKey }, fetchFn);
    if (!optionsRes.ok) {
      return {
        ok: false,
        message: OPTIONS_MESSAGES[optionsRes.status] ?? "Couldn't start the reveal.",
      };
    }
    const body = OptionsBody.safeParse(await optionsRes.json());
    if (!body.success) return { ok: false, message: "Couldn't start the reveal." };
    // Checked above for the challenge; the rest is the browser's to judge.
    const options = body.data.options as unknown as RequestJson;
    const credential = await credentials.get({ publicKey: requestOptions(options) });
    if (!credential) return { ok: false, message: "No passkey was used." };
    const response = authenticationJson(credential as PublicKeyCredential);
    const revealed = await post("/api/vault/reveal", { tenantKey, response }, fetchFn);
    if (!revealed.ok) {
      return { ok: false, message: REVEAL_MESSAGES[revealed.status] ?? "Couldn't reveal it." };
    }
    const parsed = RevealedBody.safeParse(await revealed.json());
    return parsed.success
      ? { ok: true, password: parsed.data.password }
      : { ok: false, message: UNREADABLE };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

// Clears a shown password after MASK_AFTER_MS. The returned stop clears it at once and cancels
// the timer (Hide, or leaving the page), and `clear` runs at most once either way.
export function startMaskTimer(clear: () => void, ms: number = MASK_AFTER_MS): () => void {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    clear();
  };
  const timer = setTimeout(once, ms);
  return () => {
    clearTimeout(timer);
    once();
  };
}
