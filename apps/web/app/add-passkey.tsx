"use client";

import { type FormEvent, useEffect, useState } from "react";
import { addPasskey } from "../src/passkey";

// "Add a passkey" (NS-178, ADR-0022): asks for the sign-in key again, then the browser's own
// passkey dialog. Hidden in a browser without WebAuthn.
export function AddPasskey() {
  const [supported, setSupported] = useState(false);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Checked after the first render: the server has no window, so it renders the button hidden.
  useEffect(() => {
    setSupported(typeof window.PublicKeyCredential === "function");
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const key = String(new FormData(form).get("key") ?? "");
    setBusy(true);
    setMessage(null);
    const outcome = await addPasskey(key, navigator.credentials);
    setBusy(false);
    if (outcome.ok) {
      form.reset();
      setOpen(false);
      setMessage({ ok: true, text: "Passkey added. Next time, sign in with it." });
    } else {
      setMessage({ ok: false, text: outcome.message });
    }
  }

  if (!supported) return null;
  return (
    <div>
      {open ? (
        <form onSubmit={submit}>
          <label htmlFor="passkey-key">Sign-in key (asked again to add a passkey)</label>
          <input
            id="passkey-key"
            name="key"
            type="password"
            className="field"
            autoComplete="current-password"
            required
          />
          <button type="submit" className="primary" disabled={busy}>
            Add a passkey
          </button>
        </form>
      ) : (
        <button type="button" className="secondary" onClick={() => setOpen(true)}>
          Add a passkey
        </button>
      )}
      {message && (
        <p className={message.ok ? "muted" : "error"} role={message.ok ? "status" : "alert"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
