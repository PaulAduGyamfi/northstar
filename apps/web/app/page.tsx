import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { webConfig } from "../src/config";
import { PillNav } from "../src/pill-nav";
import { readSession, SESSION_COOKIE, todayView } from "../src/session";
import { SignOutButton } from "./sign-out-button";

// Asked for on every request: the answer depends on Paul's session, never on a cached build.
export const dynamic = "force-dynamic";

// Today, the one authenticated page so far (NS-156). The guard is todayView (src/session.ts):
// signed out redirects, an unreachable API shows a notice, and only Paul gets the page.
export default async function TodayPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const view = todayView(await readSession({ apiOrigin: webConfig().apiOrigin, token, fetch }));
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
      <PillNav current="/" />
      <main className="page">
        <div className="card">
          <h1>Today</h1>
          <p className="muted">Signed in. Your queue, replies and quests will show up here.</p>
          <SignOutButton />
        </div>
      </main>
    </>
  );
}
