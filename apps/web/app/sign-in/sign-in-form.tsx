"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { apiFetch } from "../../src/client-fetch";
import { signInWithPasskey } from "../../src/passkey";

// What each API answer means for Paul, in plain words.
const MESSAGES: Record<number, string> = {
  401: "That key didn't match.",
  // The API accepts sign-in only from the web app's own address (NORTHSTAR_WEB_ORIGIN).
  403: "Open Northstar at http://northstar.localhost:3100 (or your NORTHSTAR_WEB_ORIGIN) and try again.",
  429: "Too many tries. Wait a minute, then try again.",
};

export function SignInForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A passkey button only where the browser has WebAuthn; the key form always works (ADR-0022).
  const [passkeys, setPasskeys] = useState(false);
  useEffect(() => {
    setPasskeys(typeof window.PublicKeyCredential === "function");
  }, []);

  async function withPasskey() {
    setBusy(true);
    setError(null);
    const outcome = await signInWithPasskey(navigator.credentials);
    setBusy(false);
    if (outcome.ok) router.replace("/");
    else setError(outcome.message);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = String(new FormData(event.currentTarget).get("key") ?? "");
    setBusy(true);
    setError(null);
    try {
      // Same origin: Next rewrites /api/* to the API, which sets the session cookie.
      const res = await apiFetch("/api/auth/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      });
      if (res.ok) {
        router.replace("/");
        return;
      }
      setError(MESSAGES[res.status] ?? "Couldn't sign in. Is the API running?");
    } catch {
      setError("Couldn't reach Northstar. Is the API running?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <label htmlFor="key">Sign-in key</label>
      <input
        id="key"
        name="key"
        type="password"
        className="field"
        autoComplete="current-password"
        required
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="primary" disabled={busy}>
        Sign in
      </button>
      {passkeys && (
        <button type="button" className="secondary" onClick={withPasskey} disabled={busy}>
          Sign in with a passkey
        </button>
      )}
    </form>
  );
}
