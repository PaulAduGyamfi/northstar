import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { webConfig } from "../../src/config";
import { PillNav } from "../../src/pill-nav";
import {
  ApplicationsBody,
  BAND_WORDS,
  boardColumns,
  cardTitle,
  changedAgo,
  FIT_BANDS,
  filterQuery,
  parseFilters,
  SOURCES,
  tableRows,
} from "../../src/pipeline";
import { SESSION_COOKIE } from "../../src/session";
import { dotStatus, HealthBody, readApi } from "../../src/system";

// Asked for on every request: statuses change as the pipeline runs, and it depends on Paul's session.
export const dynamic = "force-dynamic";

// The pipeline board (NS-168, DSH-001): Paul's applications by status, in words (UX-020).
// Read-only. Signed out redirects to sign-in; nothing renders without his session. Since NS-207
// also filters (in the URL, applied by the API) and a table view.
export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { filters, view } = parseFilters(await searchParams);
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const deps = { apiOrigin: webConfig().apiOrigin, token, fetch };
  const [apps, health] = await Promise.all([
    readApi(deps, `/applications${filterQuery(filters)}`, ApplicationsBody),
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
            <p className="muted">
              {filterQuery(filters) === ""
                ? "No applications yet. Jobs you queue show up here."
                : "No applications match these filters."}
            </p>
          ) : null}
          {/* A GET form, so the filters live in the URL and a view can be bookmarked. Shown only
              when the pipeline could be read: an unreachable API shows nothing else (web.md). */}
          {apps.kind === "ok" ? (
            <>
              <form method="get" action="/pipeline">
                <label>
                  Company{" "}
                  <input name="company" defaultValue={filters.company ?? ""} maxLength={100} />
                </label>
                <label>
                  Fit{" "}
                  <select name="band" defaultValue={filters.band ?? ""}>
                    <option value="">any</option>
                    {FIT_BANDS.map((b) => (
                      <option key={b} value={b}>
                        {BAND_WORDS[b]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Source{" "}
                  <select name="source" defaultValue={filters.source ?? ""}>
                    <option value="">any</option>
                    {SOURCES.map((src) => (
                      <option key={src} value={src}>
                        {src}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  From <input type="date" name="from" defaultValue={filters.from ?? ""} />
                </label>
                <label>
                  To <input type="date" name="to" defaultValue={filters.to ?? ""} />
                </label>
                {view === "table" ? <input type="hidden" name="view" value="table" /> : null}
                <button type="submit">Filter</button> <Link href="/pipeline">Clear</Link>
              </form>
              <p>
                View:{" "}
                {view === "board" ? (
                  <strong>Board</strong>
                ) : (
                  <Link href={`/pipeline${filterQuery(filters)}`}>Board</Link>
                )}{" "}
                ·{" "}
                {view === "table" ? (
                  <strong>Table</strong>
                ) : (
                  <Link href={`/pipeline${filterQuery(filters, "table")}`}>Table</Link>
                )}
              </p>
            </>
          ) : null}
        </div>
        {apps.kind === "ok" && view === "table" && apps.body.items.length > 0 ? (
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th scope="col">Job</th>
                  <th scope="col">Company</th>
                  <th scope="col">Status</th>
                  <th scope="col">Fit</th>
                  <th scope="col">Last change</th>
                </tr>
              </thead>
              <tbody>
                {tableRows(apps.body.items, now).map((r) => (
                  <tr key={r.applicationId}>
                    <td>
                      <Link href={`/pipeline/${r.applicationId}`}>{r.title}</Link>
                    </td>
                    <td>{r.company}</td>
                    <td>
                      <span className="status-label">{r.status}</span>
                    </td>
                    <td>{r.fit}</td>
                    <td className="muted">{r.changed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {apps.kind === "ok" && view === "board"
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
