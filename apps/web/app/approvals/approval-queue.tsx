"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  batchUndoLabel,
  DecideBody,
  KIND_WORDS,
  MAX_BATCH,
  type Outcome,
  type QueueItem,
  secondsLeft,
  summarizeOutcomes,
  undoErrorWords,
  waitedFor,
} from "../../src/approvals";
import { apiFetch } from "../../src/client-fetch";

// One click's decisions: undone together, inside their shared window.
type Batch = {
  key: string;
  decision: "approved" | "rejected";
  decisionIds: string[];
  // The latest effectiveAt in the batch: the button lasts as long as any of it can be undone.
  effectiveAt: string;
};

// The queue's actions (APR-002, APR-003): select, approve selected or all, reject with a reason,
// and undo each batch until its effectiveAt. Every action is a visible button, so it works by
// keyboard and on a phone (UX-043, UX-016 undo over confirm).
export function ApprovalQueue({ items }: { items: QueueItem[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Batches still inside their undo window, newest first.
  const [batches, setBatches] = useState<Batch[]>([]);
  const [now, setNow] = useState(() => Date.now());

  // Tick once a second while any undo is open, so the countdown moves.
  useEffect(() => {
    if (batches.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [batches.length]);

  const open = batches.filter((b) => secondsLeft(b.effectiveAt, now) > 0);

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function decide(ids: string[], decision: "approve" | "reject", reason?: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    const outcomes: Outcome[] = [];
    try {
      // "Approve all" over a long queue goes in batches the API accepts. On any failure it stops,
      // and what was already decided is still shown with its undo.
      for (let i = 0; i < ids.length; i += MAX_BATCH) {
        const res = await apiFetch("/api/approvals/decide", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestIds: ids.slice(i, i + MAX_BATCH),
            decision,
            ...(reason === undefined ? {} : { reason }),
          }),
        });
        if (res.status === 401) {
          setError("You've been signed out. Sign in again; nothing more was decided.");
          break;
        }
        const body = DecideBody.safeParse(await res.json().catch(() => null));
        if (!res.ok || !body.success) {
          setError(
            res.status === 400 && decision === "reject"
              ? "Add a reason, then reject again."
              : "That didn't go through. Nothing more was decided.",
          );
          break;
        }
        outcomes.push(...body.data.outcomes);
      }
    } catch {
      setError("Couldn't reach Northstar. Is the API running? Nothing more was decided.");
    } finally {
      const decided = outcomes.flatMap((o) =>
        o.outcome === "approved" || o.outcome === "rejected" ? [o] : [],
      );
      if (outcomes.length > 0) setMessage(summarizeOutcomes(outcomes));
      if (decided.length > 0) {
        const last = decided
          .map((d) => d.effectiveAt)
          .sort()
          .at(-1) as string;
        const batch: Batch = {
          key: decided[0]?.decisionId as string,
          decision: decision === "approve" ? "approved" : "rejected",
          decisionIds: decided.map((d) => d.decisionId),
          effectiveAt: last,
        };
        setBatches((b) => [batch, ...b]);
        setSelected(new Set());
        setRejecting(false);
        router.refresh();
      }
      setNow(Date.now());
      setBusy(false);
    }
  }

  async function undo(batch: Batch) {
    setBusy(true);
    setError(null);
    let undone = 0;
    let failure: string | null = null;
    const left: string[] = [];
    try {
      for (const decisionId of batch.decisionIds) {
        const res = await apiFetch("/api/approvals/undo", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decisionId }),
        });
        if (res.ok) {
          undone++;
          continue;
        }
        const body: unknown = await res.json().catch(() => null);
        failure = undoErrorWords(res.status, (body as { error?: unknown } | null)?.error);
        // Signed out or a server error: keep the rest so Paul can try again inside the window.
        if (res.status === 401 || res.status >= 500) {
          left.push(...batch.decisionIds.slice(batch.decisionIds.indexOf(decisionId)));
          break;
        }
      }
    } catch {
      failure = "Couldn't reach Northstar. Is the API running?";
      left.push(...batch.decisionIds.slice(undone));
    } finally {
      setBatches((bs) =>
        bs.flatMap((b) =>
          b.key !== batch.key ? [b] : left.length > 0 ? [{ ...b, decisionIds: left }] : [],
        ),
      );
      if (undone > 0) {
        setMessage(`Undone ${undone}. ${undone === 1 ? "It's" : "They're"} back in the queue.`);
        router.refresh();
      }
      if (failure) setError(failure);
      setBusy(false);
    }
  }

  const ids = items.map((i) => i.requestId);
  const chosen = ids.filter((id) => selected.has(id));

  return (
    <>
      {message ? <p role="status">{message}</p> : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {open.length > 0 ? (
        <p>
          {open.map((b) => (
            <button
              key={b.key}
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void undo(b)}
            >
              {batchUndoLabel(b.decision, b.decisionIds.length, secondsLeft(b.effectiveAt, now))}
            </button>
          ))}
        </p>
      ) : null}
      <ul className="switch-list">
        {items.map((item) => (
          <li key={item.requestId}>
            <label>
              <input
                type="checkbox"
                checked={selected.has(item.requestId)}
                onChange={() => toggle(item.requestId)}
              />{" "}
              <span className="status-label">Awaiting you</span>{" "}
              <strong>{KIND_WORDS[item.kind]}</strong>{" "}
              <span className="muted">
                {item.subject}, waiting {waitedFor(item.requestedAt, now)}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {rejecting ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const reason = String(new FormData(e.currentTarget).get("reason") ?? "").trim();
            void decide(chosen, "reject", reason);
          }}
        >
          <label htmlFor="reject-reason">Why reject {chosen.length === 1 ? "it" : "them"}?</label>
          <input id="reject-reason" name="reason" className="field" maxLength={500} required />
          <button type="submit" className="primary" disabled={busy || chosen.length === 0}>
            Reject {chosen.length}
          </button>{" "}
          <button type="button" className="secondary" onClick={() => setRejecting(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <p>
          <button
            type="button"
            className="primary"
            disabled={busy || chosen.length === 0}
            onClick={() => void decide(chosen, "approve")}
          >
            Approve selected ({chosen.length})
          </button>{" "}
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void decide(ids, "approve")}
          >
            Approve all ({ids.length})
          </button>{" "}
          <button
            type="button"
            className="secondary"
            disabled={busy || chosen.length === 0}
            onClick={() => setRejecting(true)}
          >
            Reject selected…
          </button>
        </p>
      )}
    </>
  );
}
