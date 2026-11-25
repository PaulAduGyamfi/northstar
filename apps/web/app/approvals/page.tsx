import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { QueueBody } from "../../src/approvals";
import { webConfig } from "../../src/config";
import { PillNav } from "../../src/pill-nav";
import { SESSION_COOKIE } from "../../src/session";
import { dotStatus, HealthBody, readApi } from "../../src/system";
import { ApprovalQueue } from "./approval-queue";

// Asked for on every request: the queue changes as agents file requests and depends on Paul's session.
export const dynamic = "force-dynamic";

// The approval queue (NS-139, APR-001): everything waiting for Paul, oldest first. Signed out
// redirects to sign-in; nothing renders without his session.
export default async function ApprovalsPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const deps = { apiOrigin: webConfig().apiOrigin, token, fetch };
  const [queue, health] = await Promise.all([
    readApi(deps, "/approvals", QueueBody),
    readApi(deps, "/system/health", HealthBody),
  ]);
  if (queue.kind === "signed_out") redirect("/sign-in");
  return (
    <>
      <PillNav current="/approvals" health={dotStatus(health)} />
      <main className="page">
        <div className="card">
          <h1>Queue</h1>
          {queue.kind !== "ok" ? (
            <p className="muted">
              {queue.kind === "unreachable"
                ? "The Northstar API isn't answering. Start it with pnpm --filter @northstar/api start."
                : "The queue can't be read right now. Nothing has been decided."}
            </p>
          ) : queue.body.items.length === 0 ? (
            <p className="muted">Queue clear. Nothing is waiting for you.</p>
          ) : (
            <>
              <p className="muted">
                Nothing here goes out until you approve it. A decision can be undone for two
                minutes.
              </p>
              <ApprovalQueue items={queue.body.items} />
            </>
          )}
        </div>
      </main>
    </>
  );
}
