"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch, isTimeout, TIMED_OUT_MESSAGE } from "../../src/client-fetch";
import {
  applicationTitle,
  decidedMessage,
  decideProblem,
  type LinkTargetView,
  type QueueChoice,
} from "../../src/inbox";

// Link and Dismiss for one thread in the confirm queue (NS-262). The API records the choice as
// Paul's for every queued message in the thread; linking never changes a status. The words after
// the choice show here, then the page reloads.
export function QueueActions({
  gmailThreadId,
  targets,
  label,
}: {
  gmailThreadId: string;
  targets: LinkTargetView[];
  // What the thread is, for the controls' accessible names.
  label: string;
}) {
  const router = useRouter();
  const [applicationId, setApplicationId] = useState(targets[0]?.applicationId ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function decide(choice: QueueChoice) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await apiFetch("/api/inbox/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          choice === "link"
            ? { gmailThreadId, decision: "link", applicationId }
            : { gmailThreadId, decision: "dismiss" },
        ),
      });
      const reply: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const code = (reply as { error?: unknown } | null)?.error;
        setError(decideProblem(code));
        if (code === "not_found") router.refresh();
        return;
      }
      const recorded = (reply as { recorded?: unknown } | null)?.recorded;
      setMessage(decidedMessage(choice, typeof recorded === "number" ? recorded : 0));
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
    <span>
      {targets.length > 0 ? (
        <>
          <select
            aria-label={`Application for ${label}`}
            value={applicationId}
            disabled={busy}
            onChange={(e) => setApplicationId(e.target.value)}
          >
            {targets.map((t) => (
              <option key={t.applicationId} value={t.applicationId}>
                {applicationTitle(t)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="secondary"
            disabled={busy || applicationId === ""}
            aria-label={`Link: ${label}`}
            onClick={() => void decide("link")}
          >
            Link
          </button>
        </>
      ) : (
        <span className="muted">No open application to link it to. </span>
      )}
      <button
        type="button"
        className="secondary"
        disabled={busy}
        aria-label={`Dismiss: ${label}`}
        onClick={() => void decide("dismiss")}
      >
        Dismiss
      </button>
      {message ? (
        <span className="muted" role="status">
          {" "}
          {message}
        </span>
      ) : null}
      {error ? (
        <span className="error" role="alert">
          {" "}
          {error}
        </span>
      ) : null}
    </span>
  );
}
