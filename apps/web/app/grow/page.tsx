import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { webConfig } from "../../src/config";
import { GrowBody, reviewLines, trackCard } from "../../src/grow";
import { PillNav } from "../../src/pill-nav";
import { SESSION_COOKIE } from "../../src/session";
import { dotStatus, HealthBody, readApi } from "../../src/system";
import { CheckInForm } from "./check-in-form";
import { ReviewButton } from "./review-button";

// Asked for on every request: a check-in shows at once, and it depends on Paul's session.
export const dynamic = "force-dynamic";

// The Grow tab (NS-214, GRW-005…007): each track's week in words, a 10-second check-in, and last
// week's review. Signed out redirects to sign-in; nothing renders without his session. Progress is
// counted, never shamed (UX-032).
export default async function GrowPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const deps = { apiOrigin: webConfig().apiOrigin, token, fetch };
  const [grow, health] = await Promise.all([
    readApi(deps, "/growth", GrowBody),
    readApi(deps, "/system/health", HealthBody),
  ]);
  if (grow.kind === "signed_out") redirect("/sign-in");
  return (
    <>
      <PillNav current="/grow" health={dotStatus(health)} />
      <main className="page">
        <div className="card">
          <h1>Grow</h1>
          {grow.kind !== "ok" ? (
            <p className="muted">
              {grow.kind === "unreachable"
                ? "The Northstar API isn't answering. Start it with pnpm --filter @northstar/api start."
                : "Your growth tracks can't be read right now."}
            </p>
          ) : grow.body.tracks.length === 0 ? (
            <p className="muted">
              No growth tracks yet. Add them with pnpm --filter @northstar/profile profile growth
              tracks set data/&lt;file&gt;.
            </p>
          ) : (
            <p className="muted">
              Week of {grow.body.weekStart} (weeks start Monday, UTC)
              {grow.body.planStored
                ? ""
                : ". No plan stored for this week yet, so planned minutes are a preview: run profile growth plan to keep one."}
            </p>
          )}
        </div>
        {grow.kind === "ok" && grow.body.tracks.length > 0 ? (
          <>
            <section className="card" aria-labelledby="check-in">
              <h2 id="check-in">Log time</h2>
              <CheckInForm tracks={grow.body.tracks.map((t) => ({ key: t.key, name: t.name }))} />
            </section>
            {grow.body.tracks.map(trackCard).map((c) => (
              <section key={c.key} className="card">
                <h2>{c.name}</h2>
                <p>
                  {c.kind} · <span className="status-label">{c.status}</span>
                </p>
                {c.percent !== null ? (
                  <p>
                    <progress value={c.percent} max={100} aria-label={`${c.name} done`} />{" "}
                    {c.percent}% done
                  </p>
                ) : null}
                <ul>
                  <li>{c.minutes}</li>
                  <li>{c.touched}</li>
                  {c.atRisk ? (
                    <li>
                      <span className="status-label">{c.atRisk}</span>
                    </li>
                  ) : null}
                  {c.streak ? <li>{c.streak}</li> : null}
                  {c.pace ? <li>{c.pace}</li> : null}
                </ul>
              </section>
            ))}
          </>
        ) : null}
        {grow.kind === "ok" ? (
          <section className="card" aria-labelledby="review">
            <h2 id="review">Week of {grow.body.lastWeek.weekStart}</h2>
            {grow.body.lastWeek.review === null ? (
              <>
                <p className="muted">Not reviewed yet.</p>
                <ReviewButton />
              </>
            ) : (
              <ul>
                {reviewLines(grow.body.lastWeek.review).map((line) => (
                  <li key={line}>{line}</li>
                ))}
                {reviewLines(grow.body.lastWeek.review).length === 0 ? (
                  <li>Nothing was planned or logged that week.</li>
                ) : null}
              </ul>
            )}
          </section>
        ) : null}
      </main>
    </>
  );
}
