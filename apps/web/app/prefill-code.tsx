"use client";

import { useEffect, useState } from "react";
import { apiFetch, isTimeout, TIMED_OUT_MESSAGE } from "../src/client-fetch";
import { countdown, GrantBody, grantMessage, prefillCode, secondsLeft } from "../src/handoffs";

// "Pre-fill" on a "Needs your hands" card (NS-192 slice 4, ADR-0030): asks the API for a one-time
// grant and shows it as a code for Paul to paste into the extension on the application's tab, with
// a Copy button and a countdown. The code lives in this component's state only (never storage, a
// cookie or the URL) and is cleared when the grant expires.
export function PrefillCode({ handoffId }: { handoffId: string }) {
  const [code, setCode] = useState<{ value: string; expiresAt: string } | null>(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Ticks once a second while a code is shown; at zero the code is gone.
  useEffect(() => {
    if (code === null) return;
    const tick = () => {
      const s = secondsLeft(code.expiresAt, Date.now());
      setLeft(s);
      if (s === 0) {
        setCode(null);
        setNote("That code expired. Press Pre-fill again for a new one.");
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [code]);

  async function ask() {
    setBusy(true);
    setNote(null);
    try {
      const res = await apiFetch("/api/handoffs/prefill-grant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handoffId }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const error =
          body !== null && typeof body === "object" && "error" in body ? String(body.error) : null;
        setNote(grantMessage(res.status, error));
        return;
      }
      const parsed = GrantBody.safeParse(body);
      const value = parsed.success ? prefillCode(handoffId, parsed.data.grant) : null;
      if (!parsed.success || value === null) {
        setNote(grantMessage(res.status, null));
        return;
      }
      setLeft(secondsLeft(parsed.data.expiresAt, Date.now()));
      setCode({ value, expiresAt: parsed.data.expiresAt });
    } catch (error) {
      setNote(
        isTimeout(error) ? TIMED_OUT_MESSAGE : "Couldn't reach Northstar. Is the API running?",
      );
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (code === null) return;
    try {
      await navigator.clipboard.writeText(code.value);
      setNote("Copied. Paste it into the Northstar extension on the application's page.");
    } catch {
      setNote("Couldn't copy. Select the code and copy it yourself.");
    }
  }

  return (
    <span className="prefill">
      {code === null ? (
        <button type="button" className="secondary" disabled={busy} onClick={() => void ask()}>
          Pre-fill
        </button>
      ) : (
        <>
          <input
            readOnly
            aria-label="Pre-fill code"
            value={code.value}
            onFocus={(e) => e.currentTarget.select()}
          />{" "}
          <button type="button" className="secondary" onClick={() => void copy()}>
            Copy
          </button>{" "}
          <span className="muted">Expires in {countdown(left)}</span>
        </>
      )}
      {note ? (
        <span className="muted" role="status">
          {" "}
          {note}
        </span>
      ) : null}
    </span>
  );
}
