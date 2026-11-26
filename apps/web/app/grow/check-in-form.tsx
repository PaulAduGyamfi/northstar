"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { apiFetch, isTimeout, TIMED_OUT_MESSAGE } from "../../src/client-fetch";
import { checkInBody, growMessage } from "../../src/grow";

// GRW-005's 10-second check-in: a track, minutes and an optional percent. One idempotency key per
// form, so a double submit stores one check-in; a new key only after one was saved.
export function CheckInForm({ tracks }: { tracks: { key: string; name: string }[] }) {
  const router = useRouter();
  const [formKey, setFormKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const body = checkInBody(
      {
        key: String(data.get("key") ?? ""),
        minutes: String(data.get("minutes") ?? ""),
        percent: String(data.get("percent") ?? ""),
      },
      formKey,
    );
    setSaved(false);
    if (body === null) {
      setError(growMessage("invalid_input"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/growth/check-ins", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const reply: unknown = await res.json().catch(() => null);
        setError(growMessage((reply as { error?: unknown } | null)?.error));
        return;
      }
      setSaved(true);
      setFormKey(crypto.randomUUID());
      form.reset();
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
    <form onSubmit={(e) => void submit(e)}>
      <label htmlFor="check-in-key">Track</label>
      <select id="check-in-key" name="key" className="field" required>
        {tracks.map((t) => (
          <option key={t.key} value={t.key}>
            {t.name}
          </option>
        ))}
      </select>
      <label htmlFor="check-in-minutes">Minutes</label>
      <input
        id="check-in-minutes"
        name="minutes"
        className="field"
        type="number"
        min={1}
        max={600}
        step={1}
        required
      />
      <label htmlFor="check-in-percent">Percent done (optional)</label>
      <input
        id="check-in-percent"
        name="percent"
        className="field"
        type="number"
        min={0}
        max={100}
        step="any"
      />
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="muted" role="status">
          Saved.
        </p>
      ) : null}
      <button type="submit" className="primary" disabled={busy}>
        Log it
      </button>
    </form>
  );
}
