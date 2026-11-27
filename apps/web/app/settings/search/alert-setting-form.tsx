"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch, isTimeout, TIMED_OUT_MESSAGE } from "../../../src/client-fetch";
import {
  type AlertField,
  type AlertSettings,
  changeBody,
  quietValue,
  saveWords,
} from "../../../src/search-settings";

// One alert setting's form (NS-199 slice 3): its input, Save and "Use the default". It goes only
// through the API's session endpoint, which checks the value like `jobs alerts set`; the change
// shows in the feed.
export function AlertSettingForm({
  field,
  settings,
}: {
  field: AlertField;
  settings: AlertSettings;
}) {
  const router = useRouter();
  const range = settings.quiet === "off" ? null : settings.quiet.split("-");
  const [off, setOff] = useState(settings.quiet === "off");
  const [start, setStart] = useState(range?.[0] ?? "22:00");
  const [end, setEnd] = useState(range?.[1] ?? "07:00");
  const [zone, setZone] = useState(settings.timeZone);
  const [tier1, setTier1] = useState(settings.tier1InQuietHours);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // The value this form would send, or null when it can't be sent yet.
  const value =
    field === "quiet"
      ? quietValue(off, start, end)
      : field === "zone"
        ? zone.trim() || null
        : String(tier1);

  async function send(body: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiFetch("/api/settings/alerts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const saved = res.ok ? ((await res.json()) as { saved?: unknown }).saved === true : null;
      setMessage(saveWords(res.status, saved));
      if (res.ok) router.refresh();
    } catch (error) {
      setMessage(isTimeout(error) ? TIMED_OUT_MESSAGE : "Couldn't reach Northstar. Not saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (value !== null) void send(changeBody(field, value));
      }}
    >
      {field === "quiet" ? (
        <fieldset>
          <legend>Quiet hours</legend>
          <label>
            <input type="checkbox" checked={off} onChange={(e) => setOff(e.target.checked)} /> Off
          </label>{" "}
          <label>
            From{" "}
            <input
              type="time"
              value={start}
              disabled={off}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>{" "}
          <label>
            to{" "}
            <input
              type="time"
              value={end}
              disabled={off}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
        </fieldset>
      ) : field === "zone" ? (
        <label>
          Time zone (an IANA name such as Europe/Berlin){" "}
          <input
            type="text"
            value={zone}
            maxLength={64}
            onChange={(e) => setZone(e.target.value)}
          />
        </label>
      ) : (
        <label>
          <input type="checkbox" checked={tier1} onChange={(e) => setTier1(e.target.checked)} />{" "}
          Alert me about tier-1 boards during quiet hours
        </label>
      )}{" "}
      <button type="submit" disabled={busy || value === null}>
        Save
      </button>{" "}
      <button type="button" disabled={busy} onClick={() => void send(changeBody(field, null))}>
        Use the default
      </button>
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}
