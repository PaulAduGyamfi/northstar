"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch, isTimeout, TIMED_OUT_MESSAGE } from "../../src/client-fetch";
import {
  DECISION_LABELS,
  decidedMessage,
  decideProblem,
  type InterviewDecision,
  type InterviewItem,
  interviewRow,
} from "../../src/interviews";

const CHOICES: readonly InterviewDecision[] = ["confirmed", "dismissed"];

// One list of detections (NS-240 slice 5). Waiting ones get Confirm and Dismiss; the API records
// the choice as Paul's, then the page says what it means and reloads the list.
export function InterviewList({ items }: { items: InterviewItem[] }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function decide(item: InterviewItem, decision: InterviewDecision) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await apiFetch("/api/interviews/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ detectionId: item.detectionId, decision }),
      });
      if (!res.ok) {
        const reply: unknown = await res.json().catch(() => null);
        const code = (reply as { error?: unknown } | null)?.error;
        setError(decideProblem(code));
        // Already decided or moved: the list on the server changed, so show it as it is now.
        if (code === "already_decided" || code === "superseded") router.refresh();
        return;
      }
      setMessage(decidedMessage(decision));
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
      <ul className="status-list">
        {items.map((item) => {
          const row = interviewRow(item);
          return (
            <li key={item.detectionId}>
              <span className="status-label">{row.status}</span>
              <strong>{row.what}</strong>
              <span className="muted">
                {row.when} · {row.who}
              </span>
              {item.decision === null ? (
                <span>
                  {CHOICES.map((decision) => (
                    <button
                      key={decision}
                      type="button"
                      className="secondary"
                      disabled={busy}
                      aria-label={`${DECISION_LABELS[decision]}: ${row.what}`}
                      onClick={() => void decide(item, decision)}
                    >
                      {DECISION_LABELS[decision]}
                    </button>
                  ))}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}
