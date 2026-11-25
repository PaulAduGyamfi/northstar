import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { webConfig } from "../../../src/config";
import { PillNav } from "../../../src/pill-nav";
import { cardTitle, STATUS_WORDS, TimelineBody } from "../../../src/pipeline";
import { SESSION_COOKIE } from "../../../src/session";
import { dotStatus, HealthBody, readApi } from "../../../src/system";

// Asked for on every request: the timeline grows as things happen, and it depends on Paul's session.
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// One application's timeline (NS-168, DSH-006): every event about it, oldest first, in the feed's
// own sentences. Read-only.
export default async function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const deps = { apiOrigin: webConfig().apiOrigin, token, fetch };
  // Only a uuid is ever put into the API path.
  const [found, health] = await Promise.all([
    UUID.test(id)
      ? readApi(deps, `/applications/timeline?id=${id}`, TimelineBody)
      : Promise.resolve({ kind: "error" as const, status: 404 }),
    readApi(deps, "/system/health", HealthBody),
  ]);
  if (found.kind === "signed_out") redirect("/sign-in");
  return (
    <>
      <PillNav current="/pipeline" health={dotStatus(health)} />
      <main className="page">
        <p>
          <Link href="/pipeline">Back to the pipeline</Link>
        </p>
        <div className="card">
          {found.kind === "ok" ? (
            <>
              <h1>{cardTitle(found.body.application)}</h1>
              <p>
                <span className="status-label">{STATUS_WORDS[found.body.application.status]}</span>
              </p>
              <h2>Timeline</h2>
              {found.body.items.length === 0 ? (
                <p className="muted">Nothing has happened to it yet.</p>
              ) : (
                <ol className="feed">
                  {found.body.items.map((i, n) => (
                    // Events have no id here; their order is fixed (oldest first).
                    // biome-ignore lint/suspicious/noArrayIndexKey: the list is static and ordered
                    <li key={n}>
                      <span className="muted">{new Date(i.occurredAt).toLocaleString()}</span>{" "}
                      {i.line}
                    </li>
                  ))}
                </ol>
              )}
            </>
          ) : (
            <p className="muted">
              {found.kind === "error" && found.status === 404
                ? "That application doesn't exist."
                : "This application can't be read right now."}
            </p>
          )}
        </div>
      </main>
    </>
  );
}
