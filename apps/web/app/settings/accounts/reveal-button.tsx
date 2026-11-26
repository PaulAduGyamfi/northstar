"use client";

import { useEffect, useRef, useState } from "react";
import { MASK_AFTER_MS, revealPassword, startMaskTimer } from "../../../src/reveal";

// "Reveal password" for one employer account (NS-246, CRD-002). The password lives only in this
// component's state, for MASK_AFTER_MS at most: Hide, the timer or leaving the page clears it.
// It is never put in storage, a cookie, the URL or a log.
export function RevealButton({ tenantKey }: { tenantKey: string }) {
  const [password, setPassword] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Stops the mask timer and clears the password; null when nothing is shown.
  const stopRef = useRef<(() => void) | null>(null);
  // False once the page is left: a reveal still in flight then drops its result instead of
  // starting a timer that would hold the password in memory for no one.
  const mountedRef = useRef(true);

  // Leaving the page clears a shown password at once. Set to true again on (re)mount: React's
  // Strict Mode runs effects twice in development, cleanup in between.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopRef.current?.();
    };
  }, []);

  // The countdown only: the mask timer itself is what clears the password.
  useEffect(() => {
    if (password === null) return;
    const tick = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(tick);
  }, [password]);

  function hide() {
    stopRef.current?.();
  }

  async function reveal() {
    setBusy(true);
    setError(null);
    try {
      // The same check as the sign-in page: no WebAuthn, no passkey prompt.
      if (typeof PublicKeyCredential === "undefined" || !("credentials" in navigator)) {
        setError("This browser can't use passkeys.");
        return;
      }
      const outcome = await revealPassword(tenantKey, navigator.credentials);
      if (!mountedRef.current) return;
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      stopRef.current?.();
      setPassword(outcome.password);
      setSecondsLeft(Math.round(MASK_AFTER_MS / 1000));
      stopRef.current = startMaskTimer(() => {
        setPassword(null);
        setSecondsLeft(0);
        stopRef.current = null;
      });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  if (password !== null) {
    return (
      <span>
        Password: <code style={{ userSelect: "all" }}>{password}</code>{" "}
        {/* Announced once; the ticking count below is not a live region. */}
        <span className="visually-hidden" role="status">
          Password shown for {Math.round(MASK_AFTER_MS / 1000)} seconds.
        </span>
        <span className="muted" aria-live="off">
          hidden again in {secondsLeft} s
        </span>{" "}
        <button type="button" onClick={hide}>
          Hide
        </button>
      </span>
    );
  }
  return (
    <span>
      <button type="button" onClick={() => void reveal()} disabled={busy}>
        {busy ? "Waiting for your passkey…" : "Reveal password"}
      </button>
      {error ? <span role="status"> {error}</span> : null}
    </span>
  );
}
