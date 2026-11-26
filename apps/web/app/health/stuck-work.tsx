"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch, isTimeout, TIMED_OUT_MESSAGE } from "../../src/client-fetch";
import {
  ACTION_LABELS,
  DEAD_LETTER_ACTIONS,
  type DeadLetterAction,
  type DeadLetterItem,
  letterLine,
  nextStep,
  resolveMessage,
} from "../../src/dead-letters";

// Stuck work (NS-215, RES-007): each open dead letter with Retry, Skip and Hand off buttons. The
// API records the resolution as Paul's; the page says what happens next, then reloads the list.
export function StuckWork({ items }: { items: DeadLetterItem[] }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function resolve(item: DeadLetterItem, action: DeadLetterAction) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await apiFetch("/api/dead-letters/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deadLetterId: item.deadLetterId, action }),
      });
      if (!res.ok) {
        const reply: unknown = await res.json().catch(() => null);
        const code = (reply as { error?: unknown } | null)?.error;
        if (code === "already_resolved") {
          setMessage(resolveMessage(code));
          router.refresh();
        } else {
          setError(resolveMessage(code));
        }
        return;
      }
      setMessage(nextStep(item.kind, action));
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
      {message ? (
        <p className="muted" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className="muted">Nothing is stuck.</p>
      ) : (
        <ul className="status-list">
          {items.map((item) => {
            const line = letterLine(item);
            return (
              <li key={item.deadLetterId}>
                <span className="status-label">Stuck</span>
                <strong>{line.what}</strong>
                <span className="muted">
                  {line.why}, {new Date(item.deadAt).toLocaleString()}
                </span>
                <span>
                  {DEAD_LETTER_ACTIONS.map((action) => (
                    <button
                      key={action}
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => void resolve(item, action)}
                    >
                      {ACTION_LABELS[action]}
                    </button>
                  ))}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
