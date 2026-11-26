"use client";

import { useState } from "react";
import { apiFetch, isTimeout } from "../../../src/client-fetch";

// A notice's exact text, read from the API only when Paul asks for it, shown as plain text.
export function NoticeText({ recordId }: { recordId: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function show() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/api/accounts/consents/text?recordId=${encodeURIComponent(recordId)}`,
      );
      const body: unknown = res.ok ? await res.json() : null;
      const value =
        body !== null && typeof body === "object" && "text" in body ? body.text : undefined;
      if (typeof value === "string") setText(value);
      else setError("The text can't be read right now.");
    } catch (e) {
      setError(isTimeout(e) ? "No answer in time." : "Couldn't reach Northstar.");
    } finally {
      setBusy(false);
    }
  }

  if (text !== null) {
    return (
      <details open>
        <summary>Text you accepted</summary>
        <p style={{ whiteSpace: "pre-wrap" }}>{text}</p>
      </details>
    );
  }
  return (
    <span>
      <button type="button" onClick={() => void show()} disabled={busy}>
        Show the text
      </button>
      {error ? <span role="status"> {error}</span> : null}
    </span>
  );
}
