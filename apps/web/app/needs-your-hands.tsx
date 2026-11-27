"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch, isTimeout, TIMED_OUT_MESSAGE } from "../src/client-fetch";
import type { HandoffCard } from "../src/handoffs";
import { PrefillCode } from "./prefill-code";

type Outcome = "submitted" | "gave_up";

// "Needs your hands" (NS-121): each application a challenge stopped, a link to open its page in a
// new tab, and Paul's word on what he did. "I submitted it" moves the application to submitted;
// "I gave up" only closes the handoff. A second click is safe: the API stores the first answer.
// "Pre-fill" (NS-192 slice 4) gives a one-time code for the extension to fill the form with.
export function NeedsYourHands({ cards }: { cards: HandoffCard[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resolve(handoffId: string, outcome: Outcome) {
    setBusy(handoffId);
    setError(null);
    try {
      const res = await apiFetch("/api/handoffs/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handoffId, outcome }),
      });
      if (res.status === 401) {
        setError("You've been signed out. Sign in again.");
        return;
      }
      if (res.status === 409) {
        setError(
          "That application isn't waiting on you any more, so it wasn't marked submitted. Choose I gave up to clear it.",
        );
        return;
      }
      if (!res.ok) {
        setError("That didn't save. Try again.");
        return;
      }
      router.refresh();
    } catch (error) {
      setError(
        isTimeout(error) ? TIMED_OUT_MESSAGE : "Couldn't reach Northstar. Is the API running?",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="switch-list">
        {cards.map((card) => (
          <li key={card.handoffId}>
            <span>
              <strong>{card.title}</strong>{" "}
              <span className="status-label" data-on={false}>
                Needs your hands
              </span>
            </span>
            <span>
              {card.href ? (
                <a href={card.href} target="_blank" rel="noopener noreferrer">
                  Open the page
                </a>
              ) : (
                <span className="muted">No safe link to open</span>
              )}{" "}
              <PrefillCode handoffId={card.handoffId} />{" "}
              <button
                type="button"
                className="primary"
                disabled={busy === card.handoffId}
                onClick={() => void resolve(card.handoffId, "submitted")}
              >
                I submitted it
              </button>{" "}
              <button
                type="button"
                className="secondary"
                disabled={busy === card.handoffId}
                onClick={() => void resolve(card.handoffId, "gave_up")}
              >
                I gave up
              </button>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
