"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../src/client-fetch";
import { FeedBody, type FeedLine, feedSubject, mergeFeed } from "../src/system";

// The activity feed (OBS-002): the lines the page was rendered with, then what's new every 3 s
// (GET /feed?after=), which keeps new items within the requirement's 5 s. A failed poll keeps the
// lines shown and tries again on the next tick.
const POLL_MS = 3_000;
const MAX_LINES = 50;

export function LiveFeed({ initial }: { initial: FeedLine[] }) {
  const [lines, setLines] = useState(initial);

  useEffect(() => {
    let newest = initial[0]?.position ?? "0";
    let stopped = false;
    const tick = async () => {
      // Nothing to show while the tab is hidden; the next visible tick catches up.
      if (stopped || document.hidden) return;
      try {
        const res = await apiFetch(`/api/feed?after=${newest}`, { cache: "no-store" });
        // Signed out or expired: stop asking until the page is loaded again.
        if (res.status === 401) {
          stopped = true;
          clearInterval(timer);
          return;
        }
        if (!res.ok || stopped) return;
        const body = FeedBody.safeParse(await res.json());
        if (!body.success || body.data.items.length === 0) return;
        newest = body.data.items.at(-1)?.position ?? newest;
        setLines((shown) => mergeFeed(shown, body.data.items, MAX_LINES));
      } catch {
        // The API is briefly unreachable: keep what's shown, try again next tick.
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [initial]);

  if (lines.length === 0) return <p className="muted">Nothing has happened yet.</p>;
  return (
    <ol className="feed" aria-live="polite">
      {lines.map((l) => {
        const subject = feedSubject(l);
        return (
          <li key={l.position}>
            <time dateTime={l.occurredAt} className="muted">
              {new Date(l.occurredAt).toLocaleTimeString()}
            </time>{" "}
            {l.line}
            {/* The job's name as plain text next to the line, never inside it (NS-189). */}
            {subject && <span className="muted"> · {subject}</span>}
          </li>
        );
      })}
    </ol>
  );
}
