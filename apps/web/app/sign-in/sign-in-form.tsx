"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

// What each API answer means for Paul, in plain words.
const MESSAGES: Record<number, string> = {
  401: "That key didn't match.",
  429: "Too many tries. Wait a minute, then try again.",
};

export function SignInForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = String(new FormData(event.currentTarget).get("key") ?? "");
    setBusy(true);
    setError(null);
    try {
      // Same origin: Next rewrites /api/* to the API, which sets the session cookie.
      const res = await fetch("/api/auth/sign-in", {
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
    </form>
  );
}
