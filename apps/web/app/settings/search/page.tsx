import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { webConfig } from "../../../src/config";
import { PillNav } from "../../../src/pill-nav";
import { AlertSettingsBody, alertRows } from "../../../src/search-settings";
import { SESSION_COOKIE } from "../../../src/session";
import { dotStatus, HealthBody, readApi } from "../../../src/system";
import { AlertSettingForm } from "./alert-setting-form";

// Asked for on every request: it needs Paul's session, and a save must show at once.
export const dynamic = "force-dynamic";

// Settings → Search (NS-199 slice 3, SRC-015/017): when fresh-job alerts are held for quiet
// hours, in which time zone, and whether tier-1 boards may break them. Each is set here or falls
// back to its ALERT_* default. The other search preferences are still `jobs prefs set`.
// Signed out redirects to sign-in.
export default async function SearchSettingsPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const deps = { apiOrigin: webConfig().apiOrigin, token, fetch };
  const [alerts, health] = await Promise.all([
    readApi(deps, "/settings/alerts", AlertSettingsBody),
    readApi(deps, "/system/health", HealthBody),
  ]);
  if (alerts.kind === "signed_out") redirect("/sign-in");
  return (
    <>
      <PillNav current="/settings/search" health={dotStatus(health)} />
      <main className="page">
        <div className="card">
          <h1>Fresh-job alerts</h1>
          {alerts.kind === "unreachable" ? (
            // The API is down: say so and show nothing else (web.md).
            <p className="muted">
              The Northstar API isn't answering. Start it with pnpm --filter @northstar/api start.
            </p>
          ) : alerts.kind !== "ok" ? (
            <p className="muted">Your alert settings can't be read right now.</p>
          ) : (
            <>
              <p className="muted">
                Inside quiet hours a new job's alert waits until they end. A change applies on the
                next alert pass.
              </p>
              <ul className="switch-list">
                {alertRows(alerts.body).map((r) => (
                  <li key={r.field}>
                    <span>
                      {r.label}: {r.value}
                    </span>
                    <span className="muted">{r.source}</span>
                    {/* Keyed by the value, so a save that changed it starts the form afresh. */}
                    <AlertSettingForm
                      key={`${r.field}:${r.value}:${r.source}`}
                      field={r.field}
                      settings={alerts.body}
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </main>
    </>
  );
}
