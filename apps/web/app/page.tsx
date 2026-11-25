import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { webConfig } from "../src/config";
import { PillNav } from "../src/pill-nav";
import { readSession, SESSION_COOKIE, todayView } from "../src/session";
import { dotStatus, FeedBody, HealthBody, readApi } from "../src/system";
import { LiveFeed } from "./live-feed";
import { SignOutButton } from "./sign-out-button";

// Asked for on every request: the answer depends on Paul's session, never on a cached build.
export const dynamic = "force-dynamic";

// Today (NS-156). The guard is todayView (src/session.ts): signed out redirects, an unreachable
// API shows a notice, and only Paul gets the page. Since NS-153 it also shows the health dot and
// the live activity feed.
export default async function TodayPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const deps = { apiOrigin: webConfig().apiOrigin, token, fetch };
  const [session, health, feed] = await Promise.all([
    readSession(deps),
    readApi(deps, "/system/health", HealthBody),
    readApi(deps, "/feed?limit=20", FeedBody),
  ]);
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
        </div>
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
