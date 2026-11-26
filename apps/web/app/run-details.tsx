"use client";

import { useState } from "react";
import { apiFetch, isTimeout } from "../src/client-fetch";
import { callLine, formatDuration, RunBody, type RunViewBody, totalsLine } from "../src/run";

// The run behind one feed line (NS-154, OBS-003): its steps with their offsets and the LLM calls
// they made, read from the API only when Paul asks. Shown as plain text.
export function RunDetails({ position }: { position: string }) {
  const [run, setRun] = useState<RunViewBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function show() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/feed/run?position=${encodeURIComponent(position)}`, {
        cache: "no-store",
      });
      const body = res.ok ? RunBody.safeParse(await res.json()) : null;
      if (body?.success) setRun(body.data);
      // Signed out or expired: say so rather than blaming the run.
      else if (res.status === 401) setError("Sign in again to see the run.");
      else setError("The run can't be read right now.");
    } catch (e) {
      setError(isTimeout(e) ? "No answer in time." : "Couldn't reach Northstar.");
    } finally {
      setBusy(false);
    }
  }

  if (run !== null) {
    return (
      <details open>
        <summary>{totalsLine(run.totals)}</summary>
        <ol>
          {run.steps.map((s) => (
            <li key={s.position}>
              <span className="muted">+{formatDuration(s.offsetMs)}</span> {s.line}
              {s.call ? <div className="muted">{callLine(s.call)}</div> : null}
            </li>
          ))}
        </ol>
        {run.truncated ? (
          <p className="muted">Only the first {run.steps.length} steps are shown.</p>
        ) : null}
      </details>
    );
  }
  return (
    <span>
      {" "}
      <button type="button" onClick={() => void show()} disabled={busy}>
        Show the run
      </button>
      {error ? <span role="status"> {error}</span> : null}
    </span>
  );
}
