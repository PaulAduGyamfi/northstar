"use client";

import { useEffect, useState } from "react";
import {
  disablePush,
  enablePush,
  type PushBrowser,
  type PushKey,
  pushStatusLine,
  readPushKey,
  supported,
} from "../src/push";

// "Turn on notifications" on Today (NS-193 slice 2, ADR-0032): a push tells Paul when an
// application needs his hands. Hidden in a browser without service workers or notifications.
function browser(): PushBrowser {
  return {
    serviceWorker: "serviceWorker" in navigator ? navigator.serviceWorker : null,
    requestPermission:
      typeof Notification === "function" ? () => Notification.requestPermission() : null,
  };
}

export function Notifications() {
  const [canPush, setCanPush] = useState(false);
  const [key, setKey] = useState<PushKey | null | undefined>(undefined);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Checked after the first render: the server has no navigator.
  useEffect(() => {
    setCanPush(supported(browser()));
    void readPushKey().then(setKey);
  }, []);

  async function run(action: typeof enablePush) {
    setBusy(true);
    setMessage(null);
    try {
      const outcome = await action(browser());
      setMessage({ ok: outcome.ok, text: outcome.message });
      setKey(await readPushKey());
    } catch {
      // A browser call that threw outside the guarded steps: say so, never leave the buttons dead.
      setMessage({ ok: false, text: "Something went wrong in this browser. Try again." });
    } finally {
      setBusy(false);
    }
  }

  if (!canPush) return null;
  return (
    <div>
      {key !== undefined && <p className="muted">{pushStatusLine(key)}</p>}
      <button type="button" className="secondary" disabled={busy} onClick={() => run(enablePush)}>
        Turn on notifications
      </button>{" "}
      <button type="button" className="secondary" disabled={busy} onClick={() => run(disablePush)}>
        Turn off here
      </button>
      {message && (
        <p className={message.ok ? "muted" : "error"} role={message.ok ? "status" : "alert"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
