import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { webConfig } from "../../src/config";
import { PillNav } from "../../src/pill-nav";
import { ApplicationsBody, boardColumns, cardTitle, changedAgo } from "../../src/pipeline";
import { SESSION_COOKIE } from "../../src/session";
import { dotStatus, HealthBody, readApi } from "../../src/system";

// Asked for on every request: statuses change as the pipeline runs, and it depends on Paul's session.
export const dynamic = "force-dynamic";

// The pipeline board (NS-168, DSH-001): Paul's applications by status, in words (UX-020).
// Read-only. Signed out redirects to sign-in; nothing renders without his session.
export default async function PipelinePage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const deps = { apiOrigin: webConfig().apiOrigin, token, fetch };
  const [apps, health] = await Promise.all([
    readApi(deps, "/applications", ApplicationsBody),
    readApi(deps, "/system/health", HealthBody),
  ]);
  if (apps.kind === "signed_out") redirect("/sign-in");
  const now = Date.now();
  return (
    <>
      <PillNav current="/pipeline" health={dotStatus(health)} />
      <main className="page">
        <div className="card">
          <h1>Pipeline</h1>
          {apps.kind !== "ok" ? (
            <p className="muted">
              {apps.kind === "unreachable"
                ? "The Northstar API isn't answering. Start it with pnpm --filter @northstar/api start."
                : "The pipeline can't be read right now."}
            </p>
          ) : apps.body.items.length === 0 ? (
            <p className="muted">No applications yet. Jobs you queue show up here.</p>
          ) : null}
        </div>
        {apps.kind === "ok"
          ? boardColumns(apps.body.items).map((column) => (
              <div className="card" key={column.word}>
                <h2>
                  <span className="status-label">{column.word}</span> {column.items.length}
                </h2>
                <ul className="switch-list">
                  {column.items.map((a) => (
                    <li key={a.applicationId}>
                      <Link href={`/pipeline/${a.applicationId}`}>{cardTitle(a)}</Link>
                      <span className="muted">{changedAgo(a.updatedAt, now)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          : null}
      </main>
    </>
  );
}
