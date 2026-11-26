"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch, isTimeout, TIMED_OUT_MESSAGE } from "../../src/client-fetch";
import { growMessage } from "../../src/grow";

// GRW-007: reviews last week once. The API stores it; the page then shows the stored review.
export function ReviewButton() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function review() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/growth/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        const reply: unknown = await res.json().catch(() => null);
        setError(growMessage((reply as { error?: unknown } | null)?.error));
        return;
      }
      router.refresh();
    } catch (caught) {
      setError(
        isTimeout(caught) ? TIMED_OUT_MESSAGE : "Couldn't reach Northstar. Is the API running?",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="button" className="secondary" disabled={busy} onClick={() => void review()}>
        Review last week
      </button>
    </>
  );
}
