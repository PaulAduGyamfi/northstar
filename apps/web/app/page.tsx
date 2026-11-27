import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { QueueBody } from "../src/approvals";
import { webConfig } from "../src/config";
import { HandoffsBody, handoffCards } from "../src/handoffs";
import { PillNav } from "../src/pill-nav";
import { readSession, SESSION_COOKIE, todayView } from "../src/session";
import { dotStatus, FeedBody, HealthBody, readApi } from "../src/system";
import { todayCounts } from "../src/today";
import { AddPasskey } from "./add-passkey";
import { LiveFeed } from "./live-feed";
import { NeedsYourHands } from "./needs-your-hands";
import { SignOutButton } from "./sign-out-button";

// Asked for on every request: the answer depends on Paul's session, never on a cached build.
export const dynamic = "force-dynamic";

// Today (NS-156). The guard is todayView (src/session.ts): signed out redirects, an unreachable
// API shows a notice, and only Paul gets the page. Since NS-153 it also shows the health dot and
// the live activity feed.
export default async function TodayPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const deps = { apiOrigin: webConfig().apiOrigin, token, fetch };
  const [session, health, feed, handoffs, approvals] = await Promise.all([
    readSession(deps),
    readApi(deps, "/system/health", HealthBody),
    readApi(deps, "/feed?limit=20", FeedBody),
    readApi(deps, "/handoffs", HandoffsBody),
    readApi(deps, "/approvals", QueueBody),
  ]);
  // What needs Paul (NS-207, DSH-003), counted from the same lists their pages show.
  const counts = todayCounts(approvals, handoffs);
  const cards = handoffs.kind === "ok" ? handoffCards(handoffs.body.items) : [];
  const view = todayView(session);
  if ("redirect" in view) redirect(view.redirect);
  if (view.render === "unreachable") {
    return (
      <main className="page">
        <div className="card">
          <h1>Northstar API unreachable</h1>
          <p className="muted">Start it with pnpm --filter @northstar/api start, then reload.</p>
        </div>
      </main>
    );
  }
  return (
    <>
      <PillNav current="/" health={dotStatus(health)} />
      <main className="page">
        <div className="card">
          <h1>Today</h1>
          <p className="muted">Signed in. Your queue, replies and quests will show up here.</p>
          <SignOutButton />
          <AddPasskey />
          {/* Settings → Accounts (NS-198): employer accounts and the consent policy. */}
          <p>
            <Link href="/settings/accounts">Settings → Accounts</Link>
          </p>
          {/* Settings → Search (NS-199 slice 3): quiet hours and the tier-1 rule for alerts. */}
          <p>
            <Link href="/settings/search">Settings → Search</Link>
          </p>
          {/* Interviews found on the calendar (NS-240 slice 5): Paul confirms or dismisses each. */}
          <p>
            <Link href="/interviews">Interviews</Link>
          </p>
        </div>
        <div className="card">
          <h2>What needs you</h2>
          <ul className="switch-list">
            {counts.map((c) => (
              <li key={c.label}>
                {c.href ? <Link href={c.href}>{c.label}</Link> : <span>{c.label}</span>}
                <span className={/^\d+$/.test(c.value) ? "status-label" : "muted"}>{c.value}</span>
              </li>
            ))}
          </ul>
        </div>
        {/* Shown only when a challenge stopped an application (NS-121). */}
        {cards.length > 0 ? (
          <div className="card" id="needs-your-hands">
            <h2>Needs your hands</h2>
            <p className="muted">
              A check only you can pass stopped these. Open the page, finish it yourself, then say
              what happened.
            </p>
            <NeedsYourHands cards={cards} />
          </div>
        ) : null}
        <div className="card">
          <h2>Activity</h2>
          {feed.kind === "ok" ? null : (
            <p className="muted">
              The activity feed can't be read right now. It fills in once it can.
            </p>
          )}
          {/* Always mounted, so polling picks the feed up once the API can read it again. */}
          <LiveFeed initial={feed.kind === "ok" ? feed.body.items : []} />
        </div>
      </main>
    </>
  );
}
