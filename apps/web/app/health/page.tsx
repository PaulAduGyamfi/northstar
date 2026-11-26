import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { webConfig } from "../../src/config";
import { DeadLettersBody } from "../../src/dead-letters";
import { PillNav } from "../../src/pill-nav";
import { SESSION_COOKIE } from "../../src/session";
import { dotStatus, HealthBody, readApi, switchList } from "../../src/system";
import { KillSwitches } from "./kill-switches";
import { StuckWork } from "./stuck-work";

// Asked for on every request: health changes by the minute and depends on Paul's session.
export const dynamic = "force-dynamic";

const WORDS = { healthy: "Working", degraded: "Needs a look", down: "Down" } as const;

// System Health (NS-153, RES-013): every subsystem worst first, with its reason, the kill
// switches (RES-008) and, since NS-215, stuck work (RES-007). Signed out redirects to sign-in; nothing renders without Paul's session.
export default async function HealthPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const deps = { apiOrigin: webConfig().apiOrigin, token, fetch };
  const [result, letters] = await Promise.all([
    readApi(deps, "/system/health", HealthBody),
    readApi(deps, "/dead-letters", DeadLettersBody),
  ]);
  if (result.kind === "signed_out") redirect("/sign-in");
  if (result.kind !== "ok") {
    // The API answered 503 (state unreadable) or not at all: the whole system counts as down.
    return (
      <>
        <PillNav current="/health" health="down" />
        <main className="page">
          <div className="card">
            <h1>System health: down</h1>
            <p className="muted">
              {result.kind === "unreachable"
                ? "The Northstar API isn't answering. Start it with pnpm --filter @northstar/api start."
                : "The API can't read Northstar's state. Check that Postgres is running and the database is migrated."}
            </p>
          </div>
        </main>
      </>
    );
  }
  const health = result.body;
  return (
    <>
      <PillNav current="/health" health={dotStatus(result)} />
      <main className="page">
        <div className="card">
          <h1>System health</h1>
          <p className="muted">
            {health.overall === "healthy"
              ? "Everything is working."
              : "Some parts need a look. The rest keeps working."}
          </p>
          {health.subsystems.length === 0 ? (
            <p className="muted">Nothing has run yet.</p>
          ) : (
            <ul className="status-list">
              {health.subsystems.map((s) => (
                <li key={s.subsystem} data-health={s.health}>
                  <span className="status-label">{WORDS[s.health]}</span>
                  <strong>{s.subsystem}</strong>
                  <span className="muted">
                    {s.reason}
                    {s.retryAt ? `, retrying at ${new Date(s.retryAt).toLocaleTimeString()}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <h2>Kill switches</h2>
          <p className="muted">
            Switching something off stops it at its next step. The change shows in the feed.
          </p>
          <KillSwitches items={switchList(health)} />
        </div>
        <div className="card">
          <h2>Stuck work</h2>
          <p className="muted">
            Work that ran out of retries waits here until you retry, skip or hand it off.
          </p>
          {letters.kind === "ok" ? (
            <StuckWork items={letters.body.items} />
          ) : (
            <p className="muted">Stuck work can't be read right now.</p>
          )}
        </div>
      </main>
    </>
  );
}
