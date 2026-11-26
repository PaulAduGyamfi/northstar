import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { webConfig } from "../../../src/config";
import { keyWords, MetricsBody, medianText, rateText, STAGE_WORDS } from "../../../src/metrics";
import { PillNav } from "../../../src/pill-nav";
import { SESSION_COOKIE } from "../../../src/session";
import { dotStatus, HealthBody, readApi } from "../../../src/system";

// Asked for on every request: the numbers move as applications do, and it needs Paul's session.
export const dynamic = "force-dynamic";

// Pipeline metrics (NS-208, DSH-002, DSH-004): the funnel with its rates, the times in stage and
// the response rate by source, fit band and time to apply. Every rate shows its count; too few
// data points say so (DX-003). Read-only.
export default async function MetricsPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const deps = { apiOrigin: webConfig().apiOrigin, token, fetch };
  const [metrics, health] = await Promise.all([
    readApi(deps, "/pipeline/metrics", MetricsBody),
    readApi(deps, "/system/health", HealthBody),
  ]);
  if (metrics.kind === "signed_out") redirect("/sign-in");
  if (metrics.kind !== "ok") {
    return (
      <>
        <PillNav current="/pipeline" health={dotStatus(health)} />
        <main className="page">
          <div className="card">
            <h1>Pipeline metrics</h1>
            <p className="muted">
              {metrics.kind === "unreachable"
                ? "The Northstar API isn't answering. Start it with pnpm --filter @northstar/api start."
                : "The metrics can't be read right now."}
            </p>
          </div>
        </main>
      </>
    );
  }
  const m = metrics.body;
  const breakdowns: [string, typeof m.responseBy.source][] = [
    ["By source", m.responseBy.source],
    ["By fit band", m.responseBy.band],
    ["By time from posting to applying", m.responseBy.timeToApply],
  ];
  return (
    <>
      <PillNav current="/pipeline" health={dotStatus(health)} />
      <main className="page">
        <div className="card">
          <h1>Pipeline metrics</h1>
          <p>
            <Link href="/pipeline">Back to the pipeline</Link>
          </p>
          <h2>Funnel</h2>
          <ul className="switch-list">
            {m.funnel.map((f) => (
              <li key={f.stage}>
                <span>{STAGE_WORDS[f.stage]}</span>
                <span className="status-label">{f.count}</span>
                {f.fromPrevious ? (
                  <span className="muted">{rateText(f.fromPrevious)} of the step before</span>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="muted">
            Screens and onsites aren't told apart yet: both count as interviewing.
          </p>
        </div>
        <div className="card">
          <h2>Time in stage (median)</h2>
          <ul className="switch-list">
            <li>
              <span>Found to applied</span>
              <span>{medianText(m.timeInStage.toApply)}</span>
            </li>
            <li>
              <span>Applied to first reply</span>
              <span>{medianText(m.timeInStage.toResponse)}</span>
            </li>
          </ul>
        </div>
        <div className="card">
          <h2>Who replies</h2>
          <p className="muted">Replies (good or bad) out of applications sent.</p>
          {breakdowns.map(([title, groups]) => (
            <div key={title}>
              <h3>{title}</h3>
              {groups.length === 0 ? (
                <p className="muted">No applications sent yet.</p>
              ) : (
                <ul className="switch-list">
                  {groups.map((g) => (
                    <li key={g.key}>
                      <span>{keyWords(g.key)}</span>
                      <span>{rateText(g.rate)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          <h3>By resume version</h3>
          <p className="muted">
            Not tracked yet: applications don't record which version they sent.
          </p>
        </div>
      </main>
    </>
  );
}
