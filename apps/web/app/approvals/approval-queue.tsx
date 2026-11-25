"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  DecideBody,
  KIND_WORDS,
  MAX_BATCH,
  type Outcome,
  type QueueItem,
  secondsLeft,
  summarizeOutcomes,
  undoLabel,
  waitedFor,
} from "../../src/approvals";

type Decided = { decisionId: string; effectiveAt: string };

// The queue's actions (APR-002, APR-003): select, approve selected or all, reject with a reason,
// and undo each decision until its effectiveAt. Every action is a visible button, so it works by
// keyboard and on a phone (UX-043, UX-016 undo over confirm).
export function ApprovalQueue({ items }: { items: QueueItem[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Decisions still inside their undo window, newest first.
  const [undoable, setUndoable] = useState<Decided[]>([]);
  const [now, setNow] = useState(() => Date.now());

  // Tick once a second while any undo is open, so the countdown moves.
  useEffect(() => {
    if (undoable.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [undoable.length]);

  const open = undoable.filter((d) => secondsLeft(d.effectiveAt, now) > 0);

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
      // "Approve all" over a long queue goes in batches the API accepts.
      for (let i = 0; i < ids.length; i += MAX_BATCH) {
        const res = await fetch("/api/approvals/decide", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestIds: ids.slice(i, i + MAX_BATCH),
            decision,
            ...(reason === undefined ? {} : { reason }),
          }),
        });
        if (res.status === 401) {
          setError("You've been signed out. Sign in again.");
          return;
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
      setMessage(summarizeOutcomes(outcomes));
      const decided = outcomes.flatMap((o) =>
        o.outcome === "approved" || o.outcome === "rejected"
          ? [{ decisionId: o.decisionId, effectiveAt: o.effectiveAt }]
          : [],
      );
      setUndoable((u) => [...decided, ...u]);
      setNow(Date.now());
      setSelected(new Set());
      setRejecting(false);
      router.refresh();
    } catch {
      setError("Couldn't reach Northstar. Is the API running?");
    } finally {
      setBusy(false);
    }
  }

  async function undo(decisionId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/approvals/undo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decisionId }),
      });
      if (res.status === 401) {
        // Keep the undo button: Paul can sign in again and still be inside the window.
        setError("You've been signed out. Sign in again to undo.");
        return;
      }
      if (res.status >= 500) {
        setError("That didn't go through. Try undo again.");
        return;
      }
      setUndoable((u) => u.filter((d) => d.decisionId !== decisionId));
      if (res.ok) {
        setMessage("Undone. It's back in the queue.");
        router.refresh();
      } else {
        const body: unknown = await res.json().catch(() => null);
        const code = (body as { error?: unknown } | null)?.error;
        setError(
          code === "undo_window_closed"
            ? "Too late to undo that one: its window has closed."
            : code === "already_undone"
              ? "That one was already undone."
              : "That decision can't be undone any more.",
        );
      }
    } catch {
      setError("Couldn't reach Northstar. Is the API running?");
    } finally {
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
          {open.map((d) => (
            <button
              key={d.decisionId}
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void undo(d.decisionId)}
            >
              {undoLabel(secondsLeft(d.effectiveAt, now))}
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
              <span className="status-label" data-on={false}>
                Awaiting you
              </span>{" "}
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
