"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  batchUndoLabel,
  changedAnswers,
  DecideBody,
  EDITED_MARK,
  editProblem,
  editResultWords,
  KIND_WORDS,
  MAX_ANSWER,
  MAX_BATCH,
  MAX_REPLY_BODY,
  type Outcome,
  type PackageAnswer,
  PackageBody,
  packageEditProblem,
  packageEditResultWords,
  packageLines,
  type QueueItem,
  ReplyBody,
  replyLines,
  secondsLeft,
  summarizeOutcomes,
  undoErrorWords,
  waitedFor,
} from "../../src/approvals";
import { apiFetch, isTimeout, TIMED_OUT_MESSAGE } from "../../src/client-fetch";

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
    } catch (error) {
      setError(
        isTimeout(error)
          ? TIMED_OUT_MESSAGE
          : "Couldn't reach Northstar. Is the API running? Nothing more was decided.",
      );
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
    } catch (error) {
      failure = isTimeout(error)
        ? TIMED_OUT_MESSAGE
        : "Couldn't reach Northstar. Is the API running?";
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
              {item.edited ? (
                <>
                  {" "}
                  <span className="status-label">{EDITED_MARK}</span>
                </>
              ) : null}
            </label>
            {item.kind === "email_reply" ? (
              <ReplyPreview requestId={item.requestId} isEdited={item.edited} />
            ) : null}
            {item.kind === "application_package" ? (
              <PackagePreview requestId={item.requestId} isEdited={item.edited} />
            ) : null}
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

// "Show the reply" for one email reply (NS-237): fetched only when Paul asks, shown as plain text.
// Since NS-203 slice 2 it also has "Edit": Paul changes the body, and saving files the edit with
// the Gate (POST /approvals/edit-reply), which withdraws this request and files the edited one.
function ReplyPreview({ requestId, isEdited }: { requestId: string; isEdited: boolean }) {
  const router = useRouter();
  const [reply, setReply] = useState<ReplyBody | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function show() {
    setError(null);
    try {
      const res = await apiFetch(`/api/approvals/reply?requestId=${encodeURIComponent(requestId)}`);
      if (res.status === 404) {
        setError("No draft is stored for this reply. Reject it to clear it.");
        return;
      }
      const parsed = res.ok ? ReplyBody.safeParse(await res.json()) : null;
      if (!parsed?.success) {
        setError("The reply couldn't be read. Try again.");
        return;
      }
      setReply(parsed.data);
    } catch (e) {
      setError(isTimeout(e) ? "No answer in time. Try again." : "Couldn't reach Northstar.");
    }
  }
  async function save(original: string, edited: string) {
    // Checked here first, so an empty or unchanged body never reaches the Gate.
    const problem = editProblem(original, edited);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch("/api/approvals/edit-reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, body: edited }),
      });
      const answer: unknown = await res.json().catch(() => null);
      const code =
        answer !== null && typeof answer === "object" && "error" in answer
          ? answer.error
          : undefined;
      setError(editResultWords(res.status, code));
      // Saved, or already gone (a second click): this request is no longer the waiting one, so
      // the queue reloads to show the edited request in its place.
      if (res.ok || code === "not_pending") {
        setDraft(null);
        setReply(null);
        router.refresh();
      }
    } catch (e) {
      setError(isTimeout(e) ? TIMED_OUT_MESSAGE : "Couldn't reach Northstar.");
    } finally {
      setSaving(false);
    }
  }
  if (reply !== null && draft !== null) {
    return (
      <div className="muted">
        <label>
          Edit the reply&apos;s text (the recipient, subject and cited items stay as they are)
          <textarea
            value={draft}
            maxLength={MAX_REPLY_BODY}
            rows={8}
            style={{ width: "100%" }}
            onChange={(e) => setDraft(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="primary"
          disabled={saving}
          onClick={() => void save(reply.body, draft)}
        >
          Save the edit
        </button>{" "}
        <button
          type="button"
          className="secondary"
          disabled={saving}
          onClick={() => setDraft(null)}
        >
          Cancel
        </button>
        {error ? <span role="status"> {error}</span> : null}
      </div>
    );
  }
  if (reply !== null) {
    const lines = replyLines(reply, isEdited);
    return (
      <div className="muted">
        {lines.map((line, i) => (
          // Lines are in a fixed order and never reorder, so the index is a stable key.
          // pre-wrap keeps the body's line breaks, so Paul reads it laid out as it will be written.
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed order, see above
          <p key={i} style={{ whiteSpace: "pre-wrap" }}>
            {line}
          </p>
        ))}
        <button type="button" className="secondary" onClick={() => setDraft(reply.body)}>
          Edit
        </button>{" "}
        <button type="button" className="secondary" onClick={() => setReply(null)}>
          Hide the reply
        </button>
      </div>
    );
  }
  return (
    <p>
      <button type="button" className="secondary" onClick={() => void show()}>
        Show the reply
      </button>
      {error ? <span role="status"> {error}</span> : null}
    </p>
  );
}

// "Show the answers" for one application package (NS-203 slice 5): fetched only when Paul asks,
// shown as plain text. "Edit" lets him change text answers; saving files the edit with the Gate
// (POST /approvals/edit-package), which withdraws this request and files the edited package, every
// answer then counting as new. Choice answers and the contact, resume and posting stay as filed.
function PackagePreview({ requestId, isEdited }: { requestId: string; isEdited: boolean }) {
  const router = useRouter();
  const [answers, setAnswers] = useState<PackageAnswer[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function show() {
    setError(null);
    try {
      const res = await apiFetch(
        `/api/approvals/package?requestId=${encodeURIComponent(requestId)}`,
      );
      if (res.status === 404) {
        setError("No package is stored for this application. Reject it to clear it.");
        return;
      }
      const parsed = res.ok ? PackageBody.safeParse(await res.json()) : null;
      if (!parsed?.success) {
        setError("The answers couldn't be read. Try again.");
        return;
      }
      setAnswers(parsed.data.answers);
    } catch (e) {
      setError(isTimeout(e) ? "No answer in time. Try again." : "Couldn't reach Northstar.");
    }
  }
  async function save(original: PackageAnswer[], edited: Record<string, string>) {
    // Checked here first, so an empty or unchanged edit never reaches the Gate.
    const changed = changedAnswers(original, edited);
    const problem = packageEditProblem(changed);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch("/api/approvals/edit-package", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, fields: changed }),
      });
      const answer: unknown = await res.json().catch(() => null);
      const code =
        answer !== null && typeof answer === "object" && "error" in answer
          ? answer.error
          : undefined;
      setError(packageEditResultWords(res.status, code));
      // Saved, or already gone (a second click): the queue reloads to show the edited request.
      if (res.ok || code === "not_pending") {
        setDrafts(null);
        setAnswers(null);
        router.refresh();
      }
    } catch (e) {
      setError(isTimeout(e) ? TIMED_OUT_MESSAGE : "Couldn't reach Northstar.");
    } finally {
      setSaving(false);
    }
  }
  if (answers !== null && drafts !== null) {
    return (
      <div className="muted">
        <p>Edit the text answers (choices, contact details and the resume stay as they are)</p>
        {answers
          .filter((a) => a.editable)
          .map((a) => (
            <label key={a.fieldName}>
              {a.label}
              <textarea
                value={drafts[a.fieldName] ?? a.value}
                maxLength={MAX_ANSWER}
                rows={4}
                style={{ width: "100%" }}
                onChange={(e) => setDrafts({ ...drafts, [a.fieldName]: e.target.value })}
              />
            </label>
          ))}
        <button
          type="button"
          className="primary"
          disabled={saving}
          onClick={() => void save(answers, drafts)}
        >
          Save the edit
        </button>{" "}
        <button
          type="button"
          className="secondary"
          disabled={saving}
          onClick={() => setDrafts(null)}
        >
          Cancel
        </button>
        {error ? <span role="status"> {error}</span> : null}
      </div>
    );
  }
  if (answers !== null) {
    const lines = packageLines(answers, isEdited);
    return (
      <div className="muted">
        {lines.map((line, i) => (
          // Lines are in a fixed order and never reorder, so the index is a stable key.
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed order, see above
          <p key={i} style={{ whiteSpace: "pre-wrap" }}>
            {line}
          </p>
        ))}
        {answers.some((a) => a.editable) ? (
          <button type="button" className="secondary" onClick={() => setDrafts({})}>
            Edit
          </button>
        ) : null}{" "}
        <button type="button" className="secondary" onClick={() => setAnswers(null)}>
          Hide the answers
        </button>
      </div>
    );
  }
  return (
    <p>
      <button type="button" className="secondary" onClick={() => void show()}>
        Show the answers
      </button>
      {error ? <span role="status"> {error}</span> : null}
    </p>
  );
}
