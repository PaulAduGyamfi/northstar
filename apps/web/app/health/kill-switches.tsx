"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { apiFetch, isTimeout, TIMED_OUT_MESSAGE } from "../../src/client-fetch";
import type { SwitchItem } from "../../src/system";

// What each refusal from POST /system/kill-switches means, in plain words.
const MESSAGES: Record<string, string> = {
  reason_required: "Add a reason, then try again.",
  invalid_subsystem: "Northstar doesn't know that switch.",
  invalid_input: "Add a reason (up to 200 characters), then try again.",
  unauthenticated: "You've been signed out. Sign in again.",
};

// Kill-switch toggles (RES-008). Each flip asks for Paul's reason first; the API stores it with
// the switch, as Paul (ADR-0002), and the page then reloads its state from the API.
export function KillSwitches({ items }: { items: SwitchItem[] }) {
  const router = useRouter();
  // The switch whose reason is being typed, if any.
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function flip(event: FormEvent<HTMLFormElement>, item: SwitchItem) {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/system/kill-switches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subsystem: item.subsystem, enabled: !item.on, reason }),
      });
      if (!res.ok) {
        // The API's refusal code picks the message; anything unknown gets a plain retry.
        const body: unknown = await res.json().catch(() => null);
        const code = (body as { error?: unknown } | null)?.error;
        setError(
          typeof code === "string" && code in MESSAGES
            ? (MESSAGES[code] as string)
            : "That didn't work. Try again.",
        );
        return;
      }
      setEditing(null);
      router.refresh();
    } catch (error) {
      setError(
        isTimeout(error) ? TIMED_OUT_MESSAGE : "Couldn't reach Northstar. Is the API running?",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <ul className="switch-list">
      {items.map((item) => (
        <li key={item.subsystem}>
          <span>
            <strong>{item.subsystem}</strong>{" "}
            <span className="status-label" data-on={item.on}>
              {item.on ? "On" : "Off"}
            </span>
          </span>
          {editing === item.subsystem ? (
            <form onSubmit={(e) => void flip(e, item)}>
              <label htmlFor={`reason-${item.subsystem}`}>
                Why switch it {item.on ? "off" : "on"}?
              </label>
              <input
                id={`reason-${item.subsystem}`}
                name="reason"
                className="field"
                maxLength={200}
                required
              />
              {error ? (
                <p className="error" role="alert">
                  {error}
                </p>
              ) : null}
              <button type="submit" className="primary" disabled={busy}>
                Switch {item.on ? "off" : "on"}
              </button>{" "}
              <button type="button" className="secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setError(null);
                setEditing(item.subsystem);
              }}
            >
              Switch {item.on ? "off" : "on"}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
