"use client";

import { useState } from "react";
import { apiFetch, isTimeout } from "../../src/client-fetch";
import { PrepPlanBody, prepPlanLines } from "../../src/prep-plan";

// "Show the plan" for one prep_plan request (NS-241 slice 6): fetched only when Paul asks, shown
// as plain text in his browser's own time zone. Read-only: approving or rejecting stays the
// queue's own buttons.
export function PrepPlanPreview({ requestId }: { requestId: string }) {
  const [plan, setPlan] = useState<PrepPlanBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function show() {
    setError(null);
    try {
      const res = await apiFetch(
        `/api/approvals/prep-plan?requestId=${encodeURIComponent(requestId)}`,
      );
      if (res.status === 404) {
        setError("No plan is stored for this request. Reject it to clear it.");
        return;
      }
      const parsed = res.ok ? PrepPlanBody.safeParse(await res.json()) : null;
      if (!parsed?.success) {
        setError("The plan couldn't be read. Try again.");
        return;
      }
      setPlan(parsed.data);
    } catch (e) {
      setError(isTimeout(e) ? "No answer in time. Try again." : "Couldn't reach Northstar.");
    }
  }
  if (plan !== null) {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return (
      <div className="muted">
        {prepPlanLines(plan, zone).map((line, i) => (
          // Lines are in a fixed order and never reorder, so the index is a stable key.
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed order, see above
          <p key={i}>{line}</p>
        ))}
        <button type="button" className="secondary" onClick={() => setPlan(null)}>
          Hide the plan
        </button>
      </div>
    );
  }
  return (
    <p>
      <button type="button" className="secondary" onClick={() => void show()}>
        Show the plan
      </button>
      {error ? <span role="status"> {error}</span> : null}
    </p>
  );
}
