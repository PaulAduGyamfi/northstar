"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch, isTimeout, TIMED_OUT_MESSAGE } from "../../src/client-fetch";
import {
  REGRADE_LETTERS,
  type RegradeLetter,
  regradedMessage,
  regradeProblem,
} from "../../src/inbox";

// Paul's own letter for a graded thread (NS-238 item 3, REC-003). The API records it as his and
// nothing else happens: no draft, send or archive. The words show here, then the page reloads.
export function RegradeControl({
  gmailThreadId,
  current,
  label,
}: {
  gmailThreadId: string;
  // His current letter, else the system's: the picker starts there.
  current: RegradeLetter;
  label: string;
}) {
  const router = useRouter();
  const [grade, setGrade] = useState<RegradeLetter>(current);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function regrade() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await apiFetch("/api/inbox/regrade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gmailThreadId, grade }),
      });
      const reply: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setError(regradeProblem((reply as { error?: unknown } | null)?.error));
        return;
      }
      setMessage(
        regradedMessage(grade, (reply as { recorded?: unknown } | null)?.recorded === true),
      );
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
      <select
        aria-label={`Your grade for ${label}`}
        value={grade}
        disabled={busy}
        onChange={(e) => setGrade(e.target.value as RegradeLetter)}
      >
        {REGRADE_LETTERS.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        aria-label={`Regrade: ${label}`}
        onClick={() => void regrade()}
      >
        Regrade
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
