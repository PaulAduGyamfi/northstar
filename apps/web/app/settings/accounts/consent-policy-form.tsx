"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CONSENT_POLICIES, type ConsentPolicy, POLICY_WORDS } from "../../../src/accounts";
import { apiFetch, isTimeout, TIMED_OUT_MESSAGE } from "../../../src/client-fetch";

// The consent policy choice (ACC-008): two radio buttons and a Save button, by keyboard as well as
// pointer. It goes only through the API's session endpoint; the change shows in the feed.
export function ConsentPolicyForm({ current }: { current: ConsentPolicy }) {
  const router = useRouter();
  const [choice, setChoice] = useState<ConsentPolicy>(current);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiFetch("/api/settings/consent-policy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ policy: choice }),
      });
      setMessage(res.ok ? "Saved." : "Not saved. Try again in a moment.");
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
        void save();
      }}
    >
      <fieldset>
        <legend>When an employer's site shows its candidate terms or privacy notice</legend>
        {CONSENT_POLICIES.map((p) => (
          <label key={p}>
            <input
              type="radio"
              name="consent-policy"
              value={p}
              checked={choice === p}
              onChange={() => setChoice(p)}
            />{" "}
            {POLICY_WORDS[p]}
          </label>
        ))}
      </fieldset>
      <button type="submit" disabled={busy || choice === current}>
        Save
      </button>
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}
